import type { Doc } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import { executorFailureRunPatch } from '@convex/lib/runs';
import { ownsActiveRunClaim } from '@convex/lib/runLease';
import { normalizeExecutorJobResult } from '@convex/lib/commandResults';
import { isRunFinalStatus, type ExecutorJobResult } from '@convex/lib/validators';
import { bumpThreadSnapshotForRun } from '@convex/lib/threadSnapshots';

export async function applyExecutorJobSuccess(
	ctx: MutationCtx,
	args: {
		job: Doc<'executorJobs'>;
		run: Doc<'runs'>;
		result: ExecutorJobResult;
		claimId: string;
	}
): Promise<boolean> {
	if (args.job.status === 'cancelled' || args.job.status === 'failed') {
		return false;
	}
	if (args.job.status === 'completed') {
		return true;
	}
	if (isRunFinalStatus(args.run.status)) {
		return false;
	}
	if (!ownsActiveRunClaim(args.run, args.claimId, Date.now())) {
		return false;
	}
	const result = normalizeExecutorJobResult(args.job.kind, args.result);
	await ctx.db.patch('executorJobs', args.job._id, {
		status: 'completed',
		result,
		completedAt: Date.now()
	});
	if (args.run.activeJobId === args.job._id) {
		await ctx.db.patch('runs', args.run._id, {
			status: 'running',
			activeJobId: undefined
		});
		await bumpThreadSnapshotForRun(ctx, args.run);
	}
	return true;
}

export async function applyExecutorJobFailure(
	ctx: MutationCtx,
	args: {
		job: Doc<'executorJobs'>;
		run: Doc<'runs'>;
		error: string;
		claimId: string;
	}
): Promise<boolean> {
	if (
		args.job.status === 'cancelled' ||
		args.job.status === 'completed' ||
		args.job.status === 'failed'
	) {
		return false;
	}
	if (!ownsActiveRunClaim(args.run, args.claimId, Date.now())) {
		return false;
	}
	const completedAt = Date.now();
	await ctx.db.patch('executorJobs', args.job._id, {
		status: 'failed',
		error: args.error,
		completedAt
	});
	const runPatch = executorFailureRunPatch({
		runStatus: args.run.status,
		activeJobId: args.run.activeJobId,
		failedJobId: args.job._id
	});
	if (runPatch) {
		await ctx.db.patch('runs', args.job.runId, runPatch);
		await bumpThreadSnapshotForRun(ctx, args.run);
	}
	return true;
}
