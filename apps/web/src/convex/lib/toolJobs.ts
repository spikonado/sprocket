import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import type { WorkId } from '@convex-dev/workpool';
import { patchRunExecution } from '@convex/lib/runExecution';
import { newToolInvocationId } from '@convex/lib/transcriptParts';
import { recordStartedToolTranscript } from '@convex/lib/transcriptWrites';
import {
	enqueueWebSearchJob,
	isCloudWebSearchKind,
	webSearchWorkpool
} from '@convex/webSearchPool';
import { unsupportedClient } from '@convex/lib/unsupportedClient';
import { cancelFirecrawlRequests } from '@convex/firecrawlRequests';
import { firecrawlScrapePool } from '@convex/lib/firecrawlPools';
import { isSettledExecutorJobStatus } from '@convex/lib/runs';

const CANCEL_PAGE_SIZE = 32;

export async function cancelWebToolWork(ctx: MutationCtx, runId: Id<'runs'>): Promise<void> {
	await cancelFirecrawlRequests(ctx, runId);
	let afterSequence = -1;
	for (;;) {
		const jobs = await ctx.db
			.query('executorJobs')
			.withIndex('by_runId_sequence', (query) =>
				query.eq('runId', runId).gt('sequence', afterSequence)
			)
			.take(CANCEL_PAGE_SIZE);
		if (jobs.length === 0) {
			return;
		}
		for (const job of jobs) {
			if (!job.cloudWorkId || isSettledExecutorJobStatus(job.status)) {
				continue;
			}
			try {
				// SAFETY: cloudWorkId is the WorkId returned by enqueueAction.
				await (job.kind === 'web_search' ? webSearchWorkpool : firecrawlScrapePool).cancel(
					ctx,
					job.cloudWorkId as WorkId
				);
			} catch {
				// Best-effort; callbacks are fenced on job/claim state.
			}
		}
		const last = jobs.at(-1);
		if (!last || jobs.length < CANCEL_PAGE_SIZE) {
			return;
		}
		afterSequence = last.sequence;
	}
}

export async function beginExecutorJob(
	ctx: MutationCtx,
	args: {
		run: Doc<'runs'>;
		claimId: string;
		kind: Doc<'executorJobs'>['kind'];
		payload: Doc<'executorJobs'>['payload'];
		callId?: string;
		hidden?: boolean;
	}
): Promise<{ jobId: Id<'executorJobs'>; sequence: number }> {
	if (args.kind === 'parse_file' && !('path' in args.payload)) {
		unsupportedClient();
	}
	const lastJob = await ctx.db
		.query('executorJobs')
		.withIndex('by_threadId_sequence', (query) => query.eq('threadId', args.run.threadId))
		.order('desc')
		.first();
	const nextSequence = (lastJob?.sequence ?? -1) + 1;
	const toolInvocationId = newToolInvocationId();

	const job: Omit<Doc<'executorJobs'>, '_id' | '_creationTime'> = {
		threadId: args.run.threadId,
		runId: args.run._id,
		kind: args.kind,
		payload: args.payload,
		hidden: args.hidden ?? false,
		status: 'claimed',
		enqueuedAt: Date.now(),
		claimedAt: Date.now(),
		sequence: nextSequence,
		toolInvocationId
	};
	if (args.callId) job.callId = args.callId;
	const jobId = await ctx.db.insert('executorJobs', job);
	if (isCloudWebSearchKind(args.kind)) {
		await enqueueWebSearchJob(ctx, {
			jobId,
			runId: args.run._id,
			claimId: args.claimId
		});
	}

	await patchRunExecution(ctx, args.run._id, { activeJobId: jobId });
	await recordStartedToolTranscript(ctx, {
		threadId: args.run.threadId,
		userId: args.run.userId,
		runId: args.run._id,
		job: { ...job, _id: jobId }
	});

	return {
		jobId,
		sequence: nextSequence
	};
}
