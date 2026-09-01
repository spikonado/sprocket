import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import { getCompletionStreamState } from '@convex/lib/assistantStreamWrites';
import { executionSecretHash } from '@convex/lib/auth';
import { isClaimedRunStatus, isRunClaimLeaseActive } from '@convex/lib/runLease';
import { isSettledExecutorJobStatus } from '@convex/lib/runs';
import { cancelRunLifecycle, startRunLifecycle } from '@convex/runLifecycle';
import { cancelWebToolWork } from '@convex/webToolPool';
import { ConvexError } from 'convex/values';

const IN_FLIGHT_CANCELLED = 'The agent worker claim expired.';

export const RUN_CANNOT_CONTINUE = 'This run cannot continue.';
export const ONLY_LATEST_RUN_CAN_CONTINUE = 'Only the latest run can continue.';

function canReopenRun(run: Doc<'runs'>, now: number): boolean {
	if (run.status === 'failed' || run.status === 'cancelled') {
		return true;
	}
	return isClaimedRunStatus(run.status) && !isRunClaimLeaseActive(run, now);
}

export function isContinuableRunStatus(
	status: Doc<'runs'>['status']
): status is 'failed' | 'cancelled' {
	return status === 'failed' || status === 'cancelled';
}

export function assertContinuableParent<
	T extends { _id: Id<'runs'>; status: Doc<'runs'>['status'] }
>(latest: T | null, parentRunId: Id<'runs'>): T {
	if (!latest || latest._id !== parentRunId) {
		throw new ConvexError(ONLY_LATEST_RUN_CAN_CONTINUE);
	}
	if (!isContinuableRunStatus(latest.status)) {
		throw new ConvexError(RUN_CANNOT_CONTINUE);
	}
	return latest;
}

export async function clearInFlightWork(
	ctx: MutationCtx,
	run: Doc<'runs'>,
	now: number
): Promise<void> {
	await cancelWebToolWork(ctx, run._id);
	const pendingQuestions = await ctx.db
		.query('agentQuestions')
		.withIndex('by_runId_sequence', (query) => query.eq('runId', run._id))
		.collect();
	for (const question of pendingQuestions) {
		if (question.status !== 'pending') {
			continue;
		}
		await ctx.db.patch('agentQuestions', question._id, {
			status: 'cancelled',
			answeredAt: now
		});
	}
	const staleJobs = await ctx.db
		.query('executorJobs')
		.withIndex('by_runId_sequence', (query) => query.eq('runId', run._id))
		.collect();
	for (const job of staleJobs) {
		if (isSettledExecutorJobStatus(job.status)) {
			continue;
		}
		await ctx.db.patch('executorJobs', job._id, {
			hidden: true,
			status: 'cancelled',
			error: IN_FLIGHT_CANCELLED,
			completedAt: now
		});
	}
	if (run.completionStreamStateId) {
		const streamState = await getCompletionStreamState(ctx, run);
		await ctx.db.patch('completionStreamStates', streamState._id, {
			sequence: 0,
			streamAttemptId: undefined
		});
	}
}

/** In-place reopen for released clients. See BACKWARDS_COMPATIBILITY.md. */
export async function reopenRunRecord(ctx: MutationCtx, run: Doc<'runs'>): Promise<void> {
	const now = Date.now();
	if (!canReopenRun(run, now)) {
		throw new ConvexError(RUN_CANNOT_CONTINUE);
	}
	const latestRun = await ctx.db
		.query('runs')
		.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', run.threadId))
		.order('desc')
		.first();
	if (!latestRun || latestRun._id !== run._id) {
		throw new ConvexError(ONLY_LATEST_RUN_CAN_CONTINUE);
	}

	await clearInFlightWork(ctx, run, now);
	if (run.lifecycleWorkflowId) {
		await cancelRunLifecycle(ctx, run.lifecycleWorkflowId);
	}
	const lifecycleWorkflowId = await startRunLifecycle(ctx, run._id);
	await ctx.db.patch('runs', run._id, {
		status: 'queued',
		startedAt: now,
		lastError: undefined,
		claimId: undefined,
		claimExpiresAt: undefined,
		completedAt: undefined,
		activeJobId: undefined,
		executionSecretHash: await executionSecretHash(`reopen:${run._id}:${now}`),
		lifecycleWorkflowId
	});
}
