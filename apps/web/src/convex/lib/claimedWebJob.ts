import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import { isSettledExecutorJobStatus } from '@convex/lib/runs';
import { ownsActiveRunClaim } from '@convex/lib/runLease';
import { getRunWithExecution, type ExecutionRun } from '@convex/lib/runExecution';

export async function claimedJobForActiveRun(
	ctx: MutationCtx,
	args: { jobId: Id<'executorJobs'>; runId: Id<'runs'>; claimId: string }
): Promise<{ job: Doc<'executorJobs'>; run: ExecutionRun } | null> {
	const job = await ctx.db.get('executorJobs', args.jobId);
	if (!job || job.runId !== args.runId || isSettledExecutorJobStatus(job.status)) return null;
	const run = await getRunWithExecution(ctx.db, args.runId);
	if (
		!run ||
		run.cancellationRequestedAt !== undefined ||
		!ownsActiveRunClaim(run, args.claimId, Date.now())
	)
		return null;
	return { job, run };
}
