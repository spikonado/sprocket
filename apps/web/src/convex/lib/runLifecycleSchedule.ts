import { internal } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import { getRunExecutionState } from '@convex/lib/runExecution';
import { isClaimedRunStatus, RUN_QUEUED_STARTUP_DEADLINE_MS } from '@convex/lib/runLease';

export function runDeadline(run: Doc<'runs'>): number | null {
	if (run.status === 'queued') return run.startedAt + RUN_QUEUED_STARTUP_DEADLINE_MS;
	if (isClaimedRunStatus(run.status)) return run.claimExpiresAt ?? 0;
	return null;
}

export async function scheduleRunLifecycleCheck(
	ctx: MutationCtx,
	state: Doc<'runExecutionStates'>,
	deadline: number
): Promise<void> {
	const generation = (state.lifecycleGeneration ?? 0) + 1;
	const lifecycleCheckId = await ctx.scheduler.runAt(
		Math.max(deadline, Date.now()),
		internal.runLifecycle.checkRun,
		{ runId: state.runId, generation }
	);
	await ctx.db.patch('runExecutionStates', state._id, {
		lifecycleCheckId,
		lifecycleGeneration: generation
	});
}

export async function cancelRunLifecycleCheck(ctx: MutationCtx, runId: Id<'runs'>): Promise<void> {
	const state = await getRunExecutionState(ctx.db, runId);
	if (!state?.lifecycleCheckId) return;
	const scheduled = await ctx.db.system.get('_scheduled_functions', state.lifecycleCheckId);
	if (scheduled?.state.kind === 'pending') await ctx.scheduler.cancel(state.lifecycleCheckId);
	await ctx.db.patch('runExecutionStates', state._id, { lifecycleCheckId: undefined });
}
