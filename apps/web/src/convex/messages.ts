import type { Doc, Id } from '@convex/_generated/dataModel';
import { query, type QueryCtx } from '@convex/_generated/server';
import { v, type Infer } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import { vThreadTranscriptQueryResult } from '@convex/lib/docs';
import { compareRunStartedAt } from '@convex/lib/runs';
import { compareTranscriptMessages, hydrateTranscriptMessages } from '@convex/lib/threadTranscript';
import { isRunFinalStatus, runFinalStatus } from '@convex/lib/validators';

const HISTORY_RUN_LIMIT = 20;

export type ThreadTranscriptQueryResult = Infer<typeof vThreadTranscriptQueryResult>;

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

	return perStatus
		.flat()
		.sort((left, right) => compareRunStartedAt(right, left))
		.slice(0, limit);
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
	returns: vThreadTranscriptQueryResult,
	handler: async (ctx, args) => {
		await requireOwnedThread(ctx, args.threadId);
		const terminalRuns = await loadNewestTerminalRuns(ctx, args.threadId, HISTORY_RUN_LIMIT);
		return hydrateSortedTranscript(ctx, args.threadId, terminalRuns);
	}
});

export const listLiveForThread = query({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: vThreadTranscriptQueryResult,
	handler: async (ctx, args) => {
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
