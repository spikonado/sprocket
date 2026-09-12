import { v } from 'convex/values';
import { omit } from 'convex-helpers';
import { internal } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { internalMutation, mutation, query, type QueryCtx } from '@convex/_generated/server';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import { isJsonObject } from '@convex/lib/json';
import {
	displayState,
	indexTranscriptPart,
	scheduleDisplayBackfill
} from '@convex/lib/transcriptDisplay';
import { displayRowValidator } from '@convex/lib/transcriptDisplayTypes';
import { getTranscriptState } from '@convex/lib/transcriptParts';
import { vAssistantMessagePart, type AssistantMessagePart } from '@convex/lib/validators';

async function requireThread(ctx: QueryCtx, threadId: Id<'threadRecords'>) {
	const userId = await getUserId(ctx);
	await getOwnedThreadRecord(ctx.db, userId, threadId);
}

export const prepare = mutation({
	args: { threadId: v.id('threadRecords') },
	returns: v.null(),
	handler: async (ctx, { threadId }) => {
		await requireThread(ctx, threadId);
		const state = await displayState(ctx, threadId);
		const transcript = await getTranscriptState(ctx, threadId);
		if (state.throughNumber < (transcript?.totalParts ?? 0))
			await scheduleDisplayBackfill(ctx, state);
		return null;
	}
});

export const backfill = internalMutation({
	args: { threadId: v.id('threadRecords') },
	returns: v.null(),
	handler: async (ctx, { threadId }) => {
		const state = await displayState(ctx, threadId);
		const transcript = await getTranscriptState(ctx, threadId);
		let remainingItems = 100;
		for (let count = 0; count < 10 && remainingItems > 0; count += 1) {
			const current = await displayState(ctx, threadId);
			if (current.throughNumber >= (transcript?.totalParts ?? 0)) break;
			const part = await ctx.db
				.query('threadTranscriptParts')
				.withIndex('by_threadId_and_number', (q) =>
					q.eq('threadId', threadId).eq('number', current.throughNumber)
				)
				.unique();
			if (!part) throw new Error('Missing transcript part while building display history.');
			await indexTranscriptPart(ctx, part, remainingItems);
			remainingItems -= Math.max(1, (part.completion?.items.length ?? 0) - current.throughIndex);
		}
		const current = await displayState(ctx, threadId);
		if (current.throughNumber < (transcript?.totalParts ?? 0)) {
			const scheduledId = await ctx.scheduler.runAfter(0, internal.transcriptDisplay.backfill, {
				threadId
			});
			await ctx.db.patch('threadTranscriptDisplayStates', state._id, { scheduledId });
		} else {
			await ctx.db.patch('threadTranscriptDisplayStates', state._id, { scheduledId: undefined });
		}
		return null;
	}
});

function pageLimit(limit: number | undefined, maximum: number) {
	if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum))
		throw new Error('Invalid display page limit.');
	return limit ?? maximum;
}

function cursor(value: number | undefined) {
	if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
		throw new Error('Invalid display cursor.');
}

const streamValidator = v.object({ runId: v.id('runs'), streamId: v.string() });
const changeCursorValidator = v.object({ revision: v.number(), sequence: v.number() });

function publicRow(row: Doc<'threadTranscriptDisplayRows'>) {
	return {
		id: row._id,
		...omit(row, [
			'_id',
			'_creationTime',
			'missingStarts',
			'missingEnds',
			'endedAt',
			'canonicalItems'
		])
	};
}

async function changedWork(
	ctx: QueryCtx,
	threadId: Id<'threadRecords'>,
	after: { revision: number; sequence: number } | undefined,
	throughNumber: number
) {
	const through = { revision: throughNumber, sequence: -1 };
	if (!after) return { changes: [], changesCursor: through, moreChanges: false };
	cursor(after.revision);
	if (!Number.isSafeInteger(after.sequence) || after.sequence < -1)
		throw new Error('Invalid change cursor.');
	const sameRevision = await ctx.db
		.query('threadTranscriptDisplayChanges')
		.withIndex('by_threadId_and_revision_and_sequence', (q) =>
			q.eq('threadId', threadId).eq('revision', after.revision).gt('sequence', after.sequence)
		)
		.take(65);
	const later =
		sameRevision.length < 65
			? await ctx.db
					.query('threadTranscriptDisplayChanges')
					.withIndex('by_threadId_and_revision_and_sequence', (q) =>
						q.eq('threadId', threadId).gt('revision', after.revision)
					)
					.take(65 - sameRevision.length)
			: [];
	const changes = [];
	const records = [...sameRevision, ...later];
	for (const change of records.slice(0, 64)) {
		const row = change.deleted
			? null
			: await ctx.db.get('threadTranscriptDisplayRows', change.rowId);
		changes.push({ id: change.rowId, row: row ? publicRow(row) : null });
	}
	const last = records[63];
	return {
		changes,
		changesCursor:
			records.length > 64 && last ? { revision: last.revision, sequence: last.sequence } : through,
		moreChanges: records.length > 64
	};
}

export const page = query({
	args: {
		threadId: v.id('threadRecords'),
		before: v.optional(v.number()),
		limit: v.optional(v.number()),
		streams: v.optional(v.array(streamValidator)),
		changesAfter: v.optional(changeCursorValidator)
	},
	returns: v.object({
		rows: v.array(displayRowValidator),
		indexing: v.boolean(),
		nextBefore: v.optional(v.number()),
		endSequence: v.number(),
		revision: v.number(),
		persistedStreams: v.array(streamValidator),
		changes: v.array(
			v.object({
				id: v.id('threadTranscriptDisplayRows'),
				row: v.union(displayRowValidator, v.null())
			})
		),
		changesCursor: changeCursorValidator,
		moreChanges: v.boolean()
	}),
	handler: async (ctx, { threadId, before, limit, streams = [], changesAfter }) => {
		await requireThread(ctx, threadId);
		cursor(before);
		if (streams.length > 64) throw new Error('Request at most 64 stream acknowledgements.');
		const count = pageLimit(limit, 40);
		const state = await ctx.db
			.query('threadTranscriptDisplayStates')
			.withIndex('by_threadId', (q) => q.eq('threadId', threadId))
			.unique();
		const transcript = await getTranscriptState(ctx, threadId);
		const indexing = (state?.throughNumber ?? 0) < (transcript?.totalParts ?? 0);
		const endSequence = state?.nextSequence ?? 0;
		const selected: Doc<'threadTranscriptDisplayRows'>[] = [];
		let more = false;
		let bytes = 0;
		if (!indexing) {
			for await (const row of ctx.db
				.query('threadTranscriptDisplayRows')
				.withIndex('by_threadId_and_sequence', (q) =>
					q.eq('threadId', threadId).lt('sequence', before ?? endSequence)
				)
				.order('desc')) {
				const size = JSON.stringify(row).length * 3;
				if (selected.length && (selected.length >= count || bytes + size > 2_000_000)) {
					more = true;
					break;
				}
				selected.push(row);
				bytes += size;
			}
		}
		selected.reverse();
		const persistedStreams = [];
		for (const stream of streams) {
			const saved = await ctx.db
				.query('threadTranscriptDisplayStreams')
				.withIndex('by_threadId_and_runId_and_streamId', (q) =>
					q.eq('threadId', threadId).eq('runId', stream.runId).eq('streamId', stream.streamId)
				)
				.unique();
			if (saved) persistedStreams.push(stream);
		}
		return {
			rows: selected.map(publicRow),
			indexing,
			endSequence,
			nextBefore: more ? selected[0]?.sequence : undefined,
			revision: state?.throughNumber ?? 0,
			persistedStreams,
			...(await changedWork(
				ctx,
				threadId,
				indexing ? undefined : changesAfter,
				state?.throughNumber ?? 0
			))
		};
	}
});

async function detailParts(
	ctx: QueryCtx,
	item: Doc<'threadTranscriptDisplayItems'>
): Promise<AssistantMessagePart[]> {
	const source = await ctx.db.get('threadTranscriptParts', item.sourcePartId);
	if (!source) throw new Error('Transcript detail source is missing.');
	const original =
		item.sourceIndex === undefined ? undefined : source.completion?.items[item.sourceIndex];
	if (item.kind === 'reasoning') {
		if (original?.type !== 'reasoning') throw new Error('Invalid reasoning detail source.');
		return [omit(original, ['providerMetadata'])];
	}
	const parts: AssistantMessagePart[] = [
		{
			type: 'tool-call',
			callId: item.callId ?? '',
			name: item.name ?? '',
			input: original?.type === 'tool-call' ? original.input : null,
			startedAt: item.startedAt
		}
	];
	if (item.resultPartId) {
		const result =
			item.resultPartId === source._id
				? source
				: await ctx.db.get('threadTranscriptParts', item.resultPartId);
		if (!result) throw new Error('Transcript tool result is missing.');
		parts.push({
			type: 'tool-result',
			callId: item.callId ?? '',
			name: item.name ?? '',
			output:
				item.sessionRunning !== undefined && isJsonObject(result.tool?.output)
					? { ...result.tool.output, running: item.sessionRunning }
					: (result.tool?.output ?? null),
			completedAt: item.completedAt
		});
	}
	return parts;
}

export const details = query({
	args: {
		threadId: v.id('threadRecords'),
		rowId: v.id('threadTranscriptDisplayRows'),
		after: v.optional(v.number()),
		before: v.optional(v.number()),
		latest: v.optional(v.boolean()),
		limit: v.optional(v.number())
	},
	returns: v.object({
		parts: v.array(vAssistantMessagePart),
		nextAfter: v.optional(v.number()),
		previousBefore: v.optional(v.number()),
		revision: v.number(),
		indexing: v.boolean()
	}),
	handler: async (ctx, { threadId, rowId, after, before, latest, limit }) => {
		await requireThread(ctx, threadId);
		cursor(after);
		cursor(before);
		if (
			(after !== undefined && before !== undefined) ||
			(latest && (after !== undefined || before !== undefined))
		)
			throw new Error('Choose one detail paging direction.');
		const count = pageLimit(limit, 5);
		const state = await ctx.db
			.query('threadTranscriptDisplayStates')
			.withIndex('by_threadId', (q) => q.eq('threadId', threadId))
			.unique();
		const transcript = await getTranscriptState(ctx, threadId);
		if ((state?.throughNumber ?? 0) < (transcript?.totalParts ?? 0)) {
			return { parts: [], revision: state?.throughNumber ?? 0, indexing: true };
		}
		const row = await ctx.db.get('threadTranscriptDisplayRows', rowId);
		if (!row || row.threadId !== threadId || row.kind !== 'work')
			throw new Error('Work section not found.');
		const backwards = latest || before !== undefined;
		const items = await ctx.db
			.query('threadTranscriptDisplayItems')
			.withIndex('by_rowId_and_order', (q) =>
				backwards
					? q.eq('rowId', rowId).lt('order', before ?? Number.MAX_SAFE_INTEGER)
					: q.eq('rowId', rowId).gt('order', after ?? -1)
			)
			.order(backwards ? 'desc' : 'asc')
			.take(count + 1);
		const selected = items.slice(0, count);
		if (backwards) selected.reverse();
		const parts: AssistantMessagePart[] = [];
		for (const item of selected) parts.push(...(await detailParts(ctx, item)));
		return {
			parts,
			nextAfter: (backwards ? before !== undefined : items.length > count)
				? selected.at(-1)?.order
				: undefined,
			previousBefore: (backwards ? items.length > count : after !== undefined)
				? selected[0]?.order
				: undefined,
			revision: row.revision,
			indexing: false
		};
	}
});
