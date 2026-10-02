import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import type { WorkId } from '@convex-dev/workpool';
import { patchRunExecution } from '@convex/lib/runExecution';
import { recordStartedToolTranscript } from '@convex/lib/transcriptWrites';
import { sameValue } from '@convex/lib/transcriptParts';
import {
	enqueueWebSearchJob,
	isCloudWebSearchKind,
	webSearchWorkpool
} from '@convex/webSearchPool';
import { firecrawlScrapePool } from '@convex/lib/firecrawlPools';
import { isSettledExecutorJobStatus } from '@convex/lib/runs';

export async function cancelCloudToolJob(
	ctx: MutationCtx,
	job: Doc<'executorJobs'>
): Promise<void> {
	if (!job.cloudWorkId || isSettledExecutorJobStatus(job.status)) return;

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

export async function beginExecutorJob(
	ctx: MutationCtx,
	args: {
		run: Doc<'runs'>;
		claimId: string;
		kind: Doc<'executorJobs'>['kind'];
		payload: Doc<'executorJobs'>['payload'];
		callId?: string;
		toolInvocationId: string;
		sectionKey?: string;
		sectionOrdinal: number;
		attemptSeq: number;
		streamId: string;
	}
): Promise<{ jobId: Id<'executorJobs'>; sequence: number }> {
	if (!Number.isSafeInteger(args.sectionOrdinal) || args.sectionOrdinal < 0) {
		throw new Error('Invalid section ordinal.');
	}

	const existing = await ctx.db
		.query('executorJobs')
		.withIndex('by_runId_and_toolInvocationId', (query) =>
			query.eq('runId', args.run._id).eq('toolInvocationId', args.toolInvocationId)
		)
		.unique();

	if (existing) {
		if (
			existing.callId !== args.callId ||
			existing.kind !== args.kind ||
			!sameValue(existing.payload, args.payload) ||
			existing.sectionKey !== args.sectionKey ||
			existing.sectionOrdinal !== args.sectionOrdinal ||
			existing.attemptSeq !== args.attemptSeq ||
			existing.streamId !== args.streamId
		) {
			throw new Error('Conflicting tool invocation retry.');
		}

		return { jobId: existing._id, sequence: existing.sequence };
	}

	const lastJob = await ctx.db
		.query('executorJobs')
		.withIndex('by_threadId_sequence', (query) => query.eq('threadId', args.run.threadId))
		.order('desc')
		.first();

	const nextSequence = (lastJob?.sequence ?? -1) + 1;

	const job: Omit<Doc<'executorJobs'>, '_id' | '_creationTime'> = {
		threadId: args.run.threadId,
		runId: args.run._id,
		kind: args.kind,
		payload: args.payload,
		status: 'claimed',
		enqueuedAt: Date.now(),
		claimedAt: Date.now(),
		sequence: nextSequence,
		toolInvocationId: args.toolInvocationId,
		sectionKey: args.sectionKey,
		sectionOrdinal: args.sectionOrdinal,
		attemptSeq: args.attemptSeq,
		streamId: args.streamId
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
	const persistedJob = await ctx.db.get('executorJobs', jobId);

	if (!persistedJob) throw new Error('Failed to create executor job.');
	await recordStartedToolTranscript(ctx, {
		threadId: args.run.threadId,
		userId: args.run.userId,
		runId: args.run._id,
		job: persistedJob
	});

	return {
		jobId,
		sequence: nextSequence
	};
}
