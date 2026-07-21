import { paginationOptsValidator } from 'convex/server';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { query, type QueryCtx } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import {
	compareTranscriptMessages,
	hydrateTranscriptMessages,
	hydrateTranscriptMessagesFromDocs,
	type ThreadTranscriptMessage
} from '@convex/lib/threadTranscript';
import { isRunFinalStatus, runFinalStatus } from '@convex/lib/validators';

const HISTORY_RUN_LIMIT = 20;
const LEGACY_PAGE_MESSAGE_LIMIT = 40;

type ThreadTranscriptQueryResult = {
	threadId: Id<'threadRecords'>;
	messages: ThreadTranscriptMessage[];
};

function compareRunsNewestFirst(left: Doc<'runs'>, right: Doc<'runs'>): number {
	if (right.startedAt !== left.startedAt) {
		return right.startedAt - left.startedAt;
	}
	return right._creationTime - left._creationTime;
}

async function requireOwnedThread(ctx: QueryCtx, threadId: Id<'threadRecords'>): Promise<void> {
	const userId = await getUserId(ctx);
	await getOwnedThreadRecord(ctx.db, userId, threadId);
}

async function loadNewestTerminalRuns(
	ctx: QueryCtx,
	threadId: Id<'threadRecords'>,
	limit: number
): Promise<Doc<'runs'>[]> {
	const perStatus = await Promise.all(
		runFinalStatus.map((status) =>
			ctx.db
				.query('runs')
				.withIndex('by_threadId_status_startedAt', (query) =>
					query.eq('threadId', threadId).eq('status', status)
				)
				.order('desc')
				.take(limit)
		)
	);

	return perStatus.flat().sort(compareRunsNewestFirst).slice(0, limit);
}

async function hydrateSortedTranscript(
	ctx: QueryCtx,
	threadId: Id<'threadRecords'>,
	runs: Doc<'runs'>[]
): Promise<ThreadTranscriptQueryResult> {
	const messages = (await hydrateTranscriptMessages(ctx, runs)).sort(compareTranscriptMessages);
	return { threadId, messages };
}

export const listHistoryForThread = query({
	args: {
		threadId: v.id('threadRecords')
	},
	handler: async (ctx, args): Promise<ThreadTranscriptQueryResult> => {
		await requireOwnedThread(ctx, args.threadId);
		const terminalRuns = await loadNewestTerminalRuns(ctx, args.threadId, HISTORY_RUN_LIMIT);
		return hydrateSortedTranscript(ctx, args.threadId, terminalRuns);
	}
});

export const listLiveForThread = query({
	args: {
		threadId: v.id('threadRecords')
	},
	handler: async (ctx, args): Promise<ThreadTranscriptQueryResult> => {
		await requireOwnedThread(ctx, args.threadId);

		const latestRun = await ctx.db
			.query('runs')
			.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', args.threadId))
			.order('desc')
			.first();

		if (!latestRun || isRunFinalStatus(latestRun.status)) {
			return { threadId: args.threadId, messages: [] };
		}

		return hydrateSortedTranscript(ctx, args.threadId, [latestRun]);
	}
});

/** @deprecated Prefer listHistoryForThread + listLiveForThread. Kept for older released clients. */
export const listForThread = query({
	args: {
		threadId: v.id('threadRecords'),
		paginationOpts: paginationOptsValidator
	},
	handler: async (ctx, args) => {
		await requireOwnedThread(ctx, args.threadId);

		const numItems = Math.min(LEGACY_PAGE_MESSAGE_LIMIT, Math.max(1, args.paginationOpts.numItems));
		const pageResult = await ctx.db
			.query('threadMessages')
			.withIndex('by_threadId', (query) => query.eq('threadId', args.threadId))
			.order('desc')
			.paginate({
				...args.paginationOpts,
				numItems
			});

		const messages = (await hydrateTranscriptMessagesFromDocs(ctx, pageResult.page)).sort(
			compareTranscriptMessages
		);

		return {
			threadId: args.threadId,
			page: messages,
			isDone: pageResult.isDone,
			continueCursor: pageResult.continueCursor,
			pageStatus: pageResult.pageStatus ?? null,
			splitCursor: pageResult.splitCursor ?? null
		};
	}
});
