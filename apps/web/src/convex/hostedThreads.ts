import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { query, type QueryCtx } from '@convex/_generated/server';
import type { Doc, Id } from '@convex/_generated/dataModel';
import schema from '@convex/schema';
import { v } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import { transcriptHistoryFromNumber } from '@convex/lib/contextHandoff';
import {
	hydrateTranscriptPartUrls,
	getTranscriptState,
	loadTranscriptPartsByNumbers,
	MAX_TRANSCRIPT_PARTS_PER_QUERY
} from '@convex/lib/transcriptParts';
import {
	HOSTED_TRANSCRIPT_DETAIL_CHUNK_SIZE,
	HOSTED_TRANSCRIPT_PAGE_SIZE,
	messagePageStart,
	projectTranscriptMessages,
	projectablePartFromDoc
} from '@convex/lib/hostedTranscript';
import { vAssistantMessagePart, vRunStatus } from '@convex/lib/validators';

export { HOSTED_THREAD_PAGE_SIZE } from '@convex/lib/hostedThreadList';

const vHostedMessageAttachment = v.object({
	imageUploadId: v.id('imageUploads'),
	name: v.string(),
	mediaType: v.string(),
	size: v.number(),
	url: v.union(v.string(), v.null())
});

export const vHostedTranscriptMessage = v.object({
	_id: v.string(),
	_creationTime: v.optional(v.number()),
	threadId: v.id('threadRecords'),
	runId: v.id('runs'),
	userId: v.string(),
	type: v.union(v.literal('prompt'), v.literal('response')),
	text: v.string(),
	attachments: v.array(vHostedMessageAttachment),
	parts: v.array(vAssistantMessagePart),
	runStatus: vRunStatus,
	runStartedAt: v.number(),
	runCompletedAt: v.optional(v.number()),
	sourceNumbers: v.optional(v.array(v.number())),
	streamIds: v.optional(v.array(v.string())),
	detailsLoaded: v.optional(v.boolean())
});

export const vHostedTranscriptPage = v.object({
	threadId: v.id('threadRecords'),
	totalParts: v.number(),
	historyFromNumber: v.number(),
	stale: v.boolean(),
	messages: v.array(vHostedTranscriptMessage),
	nextBefore: v.optional(v.number())
});

export const vHostedTranscriptWatch = v.object({
	threadId: v.id('threadRecords'),
	userId: v.string(),
	totalParts: v.number(),
	historyFromNumber: v.number(),
	latestPartNumber: v.union(v.number(), v.null()),
	latestPartId: v.union(v.id('threadTranscriptParts'), v.null()),
	latestPartCreationTime: v.union(v.number(), v.null()),
	latestSourceKey: v.union(v.string(), v.null()),
	latestRunId: v.union(v.id('runs'), v.null()),
	latestRunStatus: v.union(vRunStatus, v.null())
});

const vHostedThreadPage = paginationResultValidator(schema.doc('threadRecords')).extend({
	selected: v.union(schema.doc('threadRecords'), v.null())
});

async function requireOwnedThread(ctx: QueryCtx, threadId: Id<'threadRecords'>) {
	const userId = await getUserId(ctx);
	const thread = await getOwnedThreadRecord(ctx.db, userId, threadId);
	return { userId, thread };
}

export const listPage = query({
	args: {
		paginationOpts: paginationOptsValidator,
		selectedThreadId: v.optional(v.id('threadRecords'))
	},
	returns: vHostedThreadPage,
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const result = await ctx.db
			.query('threadRecords')
			.withIndex('by_userId_lastMessageAt', (query) => query.eq('userId', userId))
			.order('desc')
			.paginate(args.paginationOpts);
		let selected: Doc<'threadRecords'> | null = null;
		if (
			args.selectedThreadId &&
			!result.page.some((thread) => thread._id === args.selectedThreadId)
		) {
			const record = await ctx.db.get('threadRecords', args.selectedThreadId);
			if (record?.userId === userId) {
				selected = record;
			}
		}
		return { ...result, selected };
	}
});

async function loadPartsEndingAt(
	ctx: QueryCtx,
	threadId: Id<'threadRecords'>,
	endExclusive: number
): Promise<Doc<'threadTranscriptParts'>[]> {
	if (endExclusive <= 0) {
		return [];
	}
	const rows = await ctx.db
		.query('threadTranscriptParts')
		.withIndex('by_threadId_and_number', (query) =>
			query.eq('threadId', threadId).lt('number', endExclusive)
		)
		.order('desc')
		.paginate({
			numItems: MAX_TRANSCRIPT_PARTS_PER_QUERY,
			cursor: null,
			maximumBytesRead: 4 * 1024 * 1024
		});
	return rows.page.reverse();
}

export const transcriptPage = query({
	args: {
		threadId: v.id('threadRecords'),
		before: v.optional(v.number()),
		limit: v.optional(v.number())
	},
	returns: vHostedTranscriptPage,
	handler: async (ctx, args) => {
		const { userId, thread } = await requireOwnedThread(ctx, args.threadId);
		const state = await getTranscriptState(ctx, args.threadId);
		const totalParts = state?.totalParts ?? 0;
		const historyFromNumber = await transcriptHistoryFromNumber(ctx, thread);
		const limit = Math.min(
			MAX_TRANSCRIPT_PARTS_PER_QUERY,
			Math.max(1, args.limit ?? HOSTED_TRANSCRIPT_PAGE_SIZE)
		);
		const endExclusive = Math.min(args.before ?? totalParts, totalParts);
		if (endExclusive <= 0) {
			return {
				threadId: args.threadId,
				totalParts,
				historyFromNumber,
				stale: false,
				messages: []
			};
		}

		const loaded = await loadPartsEndingAt(ctx, args.threadId, endExclusive);
		const oldestNumber = loaded[0]?.number ?? 0;
		const pageStart = messagePageStart(loaded, limit, oldestNumber === 0) ?? oldestNumber;
		const sliced = loaded.filter((part) => part.number >= pageStart);
		const hydrated = await hydrateTranscriptPartUrls(ctx, sliced);
		const messages = projectTranscriptMessages({
			userId,
			threadId: args.threadId,
			parts: hydrated.map(projectablePartFromDoc),
			includeDetails: false
		});
		if (pageStart > 0) {
			return {
				threadId: args.threadId,
				totalParts,
				historyFromNumber,
				stale: false,
				messages,
				nextBefore: pageStart
			};
		}
		return {
			threadId: args.threadId,
			totalParts,
			historyFromNumber,
			stale: false,
			messages
		};
	}
});

export const transcriptDetails = query({
	args: {
		threadId: v.id('threadRecords'),
		numbers: v.array(v.number())
	},
	returns: v.union(vHostedTranscriptMessage, v.null()),
	handler: async (ctx, args) => {
		const { userId } = await requireOwnedThread(ctx, args.threadId);
		if (args.numbers.length === 0 || args.numbers.length > HOSTED_TRANSCRIPT_DETAIL_CHUNK_SIZE) {
			throw new Error('invalid transcript detail range');
		}
		if (args.numbers.some((number, index) => index > 0 && args.numbers[index - 1]! >= number)) {
			throw new Error('transcript detail numbers must be strictly increasing');
		}
		const parts = await hydrateTranscriptPartUrls(
			ctx,
			await loadTranscriptPartsByNumbers(ctx, args.threadId, args.numbers)
		);
		if (parts.length !== args.numbers.length) {
			return null;
		}
		const messages = projectTranscriptMessages({
			userId,
			threadId: args.threadId,
			parts: parts.map(projectablePartFromDoc),
			includeDetails: true
		});
		return messages.length === 1 ? messages[0] : null;
	}
});

export const transcriptWatch = query({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: vHostedTranscriptWatch,
	handler: async (ctx, args) => {
		const { userId, thread } = await requireOwnedThread(ctx, args.threadId);
		const state = await getTranscriptState(ctx, args.threadId);
		const historyFromNumber = await transcriptHistoryFromNumber(ctx, thread);
		const latestPart = await ctx.db
			.query('threadTranscriptParts')
			.withIndex('by_threadId_and_number', (query) => query.eq('threadId', args.threadId))
			.order('desc')
			.first();
		const latestRun = await ctx.db
			.query('runs')
			.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', args.threadId))
			.order('desc')
			.first();
		return {
			threadId: args.threadId,
			userId,
			totalParts: state?.totalParts ?? 0,
			historyFromNumber,
			latestPartNumber: latestPart?.number ?? null,
			latestPartId: latestPart?._id ?? null,
			latestPartCreationTime: latestPart?._creationTime ?? null,
			latestSourceKey: latestPart?.sourceKey ?? null,
			latestRunId: latestRun?._id ?? null,
			latestRunStatus: latestRun?.status ?? null
		};
	}
});
