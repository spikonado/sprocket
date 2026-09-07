import type { Doc, Id } from '@convex/_generated/dataModel';
import { mutation, query, type QueryCtx } from '@convex/_generated/server';
import { ConvexError, v, type Infer } from 'convex/values';
import { parse } from 'convex-helpers/validators';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { assertRunAcceptsModelCompletion, RUN_NO_LONGER_ACTIVE } from '@convex/lib/agentErrors';
import { joinAssistantTextParts } from '@convex/lib/assistantParts';
import { getCompletionStreamState } from '@convex/lib/assistantStreamWrites';
import { getExecutionRun, getUserId } from '@convex/lib/auth';
import { vJsonValue } from '@convex/lib/json';
import { isCurrentCompletionAttempt, ownsActiveRunClaim } from '@convex/lib/runLease';
import { completionSourceKey } from '@convex/lib/transcriptParts';
import { isRunFinalStatus, vRunStatus } from '@convex/lib/validators';

/** Oversize JSON/parts are rejected; the previous overlay stays. */
export const MAX_LIVE_SNAPSHOT_BYTES = 64 * 1024;
export const MAX_LIVE_PARTS = 256;
export const MAX_LIVE_ID_CHARS = 256;

const vLiveTimestamp = v.optional(v.number());

const vLiveTextPart = v.object({
	type: v.literal('text'),
	id: v.string(),
	text: v.string(),
	startedAt: vLiveTimestamp,
	completedAt: vLiveTimestamp,
	turnId: v.optional(v.string())
});

const vLiveReasoningPart = v.object({
	type: v.literal('reasoning'),
	id: v.string(),
	text: v.string(),
	startedAt: vLiveTimestamp,
	completedAt: vLiveTimestamp,
	turnId: v.optional(v.string())
});

const vLiveToolCallPart = v.object({
	type: v.literal('tool-call'),
	partId: v.optional(v.string()),
	callId: v.string(),
	name: v.string(),
	input: vJsonValue,
	startedAt: vLiveTimestamp,
	completedAt: vLiveTimestamp,
	turnId: v.optional(v.string())
});

export const vLiveAssistantPart = v.union(vLiveTextPart, vLiveReasoningPart, vLiveToolCallPart);

export const vLiveCompletionOverlay = v.object({
	threadId: v.id('threadRecords'),
	runId: v.id('runs'),
	runStatus: vRunStatus,
	streamId: v.optional(v.string()),
	text: v.string(),
	parts: v.array(vLiveAssistantPart),
	runStartedAt: v.number()
});

const vStoredLiveOverlay = v.object({
	claimId: v.string(),
	attemptSeq: v.number(),
	streamId: v.string(),
	text: v.string(),
	parts: v.array(vLiveAssistantPart)
});

export type LiveAssistantPart = Infer<typeof vLiveAssistantPart>;
export type LiveCompletionOverlay = Infer<typeof vLiveCompletionOverlay>;
type StoredLiveOverlay = Infer<typeof vStoredLiveOverlay>;

function requirePositiveInteger(label: string, value: number): number {
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${label} is invalid.`);
	}
	return value;
}

function requireBoundedId(label: string, value: string): string {
	if (!value || value.length > MAX_LIVE_ID_CHARS) {
		throw new Error(`${label} is invalid.`);
	}
	return value;
}

function utf8Bytes(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

function livePartForStore(part: LiveAssistantPart): LiveAssistantPart {
	if (part.type === 'tool-call') {
		const stored: LiveAssistantPart = {
			type: 'tool-call',
			callId: requireBoundedId('call ID', part.callId),
			name: requireBoundedId('tool name', part.name),
			input: part.input
		};
		if (part.partId !== undefined) stored.partId = requireBoundedId('part ID', part.partId);
		if (part.turnId !== undefined) stored.turnId = requireBoundedId('turn ID', part.turnId);
		if (part.startedAt !== undefined) stored.startedAt = part.startedAt;
		if (part.completedAt !== undefined) stored.completedAt = part.completedAt;
		return stored;
	}
	const stored: LiveAssistantPart = {
		type: part.type,
		id: requireBoundedId('part ID', part.id),
		text: part.text
	};
	if (part.turnId !== undefined) stored.turnId = requireBoundedId('turn ID', part.turnId);
	if (part.startedAt !== undefined) stored.startedAt = part.startedAt;
	if (part.completedAt !== undefined) stored.completedAt = part.completedAt;
	return stored;
}

/** Matches Rust `visible_live_parts`: empty reasoning is provider-only. */
export function visibleLiveParts(parts: LiveAssistantPart[]): LiveAssistantPart[] {
	return parts.filter((part) => part.type !== 'reasoning' || part.text.trim() !== '');
}

function encodeStoredOverlay(overlay: StoredLiveOverlay): string {
	const json = JSON.stringify(overlay);
	if (utf8Bytes(json) > MAX_LIVE_SNAPSHOT_BYTES) {
		throw new Error('Live snapshot is too large.');
	}
	return json;
}

function parseStoredOverlay(json: string): StoredLiveOverlay | null {
	try {
		const stored = parse(vStoredLiveOverlay, JSON.parse(json));
		if (stored.parts.length > MAX_LIVE_PARTS) return null;
		return {
			claimId: requireBoundedId('claim ID', stored.claimId),
			attemptSeq: requirePositiveInteger('attempt sequence', stored.attemptSeq),
			streamId: requireBoundedId('stream ID', stored.streamId),
			text: stored.text,
			parts: visibleLiveParts(stored.parts.map(livePartForStore))
		};
	} catch {
		return null;
	}
}

function overlayForClient(run: Doc<'runs'>, stored: StoredLiveOverlay): LiveCompletionOverlay {
	const parts = stored.parts;
	return {
		threadId: run.threadId,
		runId: run._id,
		runStatus: run.status,
		streamId: stored.streamId,
		text: joinAssistantTextParts(parts),
		parts,
		runStartedAt: run.startedAt
	};
}

async function latestRunForThread(
	ctx: QueryCtx,
	threadId: Id<'threadRecords'>
): Promise<Doc<'runs'> | null> {
	return await ctx.db
		.query('runs')
		.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', threadId))
		.order('desc')
		.first();
}

export const publish = mutation({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		attemptSeq: v.number(),
		streamId: v.string(),
		sequence: v.number(),
		text: v.string(),
		parts: v.array(vLiveAssistantPart),
		executionSecret: v.string()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
		assertRunAcceptsModelCompletion(run);
		requireBoundedId('claim ID', args.claimId);
		requireBoundedId('stream ID', args.streamId);
		requirePositiveInteger('attempt sequence', args.attemptSeq);
		if (!ownsActiveRunClaim(run, args.claimId, Date.now())) {
			throw new ConvexError(RUN_NO_LONGER_ACTIVE);
		}
		if (!isCurrentCompletionAttempt(run, args.claimId, args.attemptSeq)) {
			throw new Error('Live snapshot is not for the current completion attempt.');
		}
		const state = await getCompletionStreamState(ctx, run);
		const sequence = requirePositiveInteger('Live snapshot sequence', args.sequence);
		const sameEpoch =
			state.liveEpochClaimId === args.claimId && state.liveEpochAttemptSeq === args.attemptSeq;
		if (sameEpoch && sequence <= state.sequence) {
			throw new Error('Live snapshot sequence is stale.');
		}
		if (args.parts.length > MAX_LIVE_PARTS) {
			throw new Error('Live snapshot has too many parts.');
		}
		const parts = visibleLiveParts(args.parts.map(livePartForStore));
		const liveOverlayJson = encodeStoredOverlay({
			claimId: args.claimId,
			attemptSeq: args.attemptSeq,
			streamId: args.streamId,
			text: args.text,
			parts
		});
		await ctx.db.patch('completionStreamStates', state._id, {
			sequence,
			liveOverlayJson,
			liveEpochClaimId: args.claimId,
			liveEpochAttemptSeq: args.attemptSeq
		});
		return null;
	}
});

export const get = query({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: v.union(vLiveCompletionOverlay, v.null()),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		await getOwnedThreadRecord(ctx.db, userId, args.threadId);
		const run = await latestRunForThread(ctx, args.threadId);
		if (!run || isRunFinalStatus(run.status) || !run.completionStreamStateId) {
			return null;
		}
		const state = await ctx.db.get('completionStreamStates', run.completionStreamStateId);
		if (
			!state ||
			state.runId !== run._id ||
			state.userId !== run.userId ||
			state.liveOverlayJson === undefined
		) {
			return null;
		}
		const stored = parseStoredOverlay(state.liveOverlayJson);
		if (
			!stored ||
			stored.claimId !== run.claimId ||
			stored.attemptSeq !== run.completionAttemptSeq
		) {
			return null;
		}
		const durable = await ctx.db
			.query('threadTranscriptParts')
			.withIndex('by_threadId_and_sourceKey', (query) =>
				query
					.eq('threadId', run.threadId)
					.eq('sourceKey', completionSourceKey(run._id, stored.streamId))
			)
			.unique();
		if (durable) return null;
		return overlayForClient(run, stored);
	}
});
