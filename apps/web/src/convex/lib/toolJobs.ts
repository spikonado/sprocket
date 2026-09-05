import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import { setRunAndThreadStatus } from '@convex/lib/threadRunStatus';
import { newToolInvocationId } from '@convex/lib/transcriptParts';
import { recordStartedToolTranscript } from '@convex/lib/transcriptWrites';
import { enqueueWebToolJob, isCloudWebToolKind } from '@convex/webToolPool';

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
	if (isCloudWebToolKind(args.kind)) {
		await enqueueWebToolJob(ctx, {
			jobId,
			runId: args.run._id,
			claimId: args.claimId,
			kind: args.kind
		});
	}

	await setRunAndThreadStatus(ctx, args.run, 'awaiting_executor', { activeJobId: jobId });
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
