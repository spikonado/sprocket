import { cancel, defineWorkflow, start, vWorkflowId, type WorkflowId } from '@convex-dev/workflow';
import { v } from 'convex/values';
import { components, internal } from '@convex/_generated/api';
import { internalMutation, internalQuery, type MutationCtx } from '@convex/_generated/server';
import type { Doc, Id } from '@convex/_generated/dataModel';
import {
	isClaimedRunStatus,
	isRunClaimLeaseActive,
	RUN_QUEUED_STARTUP_DEADLINE_MS
} from '@convex/lib/runLease';
import { advanceTerminalCleanup } from '@convex/lib/runTerminal';
import { finalizeRunRecord } from '@convex/lib/runFinalize';
import { RUN_ABANDONED_BY_AGENT } from '@convex/lib/agentErrors';
import { isRunFinalStatus } from '@convex/lib/validators';
const MAX_SLEEP_MS = RUN_QUEUED_STARTUP_DEADLINE_MS;

type RunWatchState =
	| { kind: 'terminal'; completedAt: number }
	| { kind: 'abandon' }
	| { kind: 'wait'; waitMs: number };

function watchStateForRun(run: Doc<'runs'>, now: number): RunWatchState {
	if (isRunFinalStatus(run.status)) {
		return { kind: 'terminal', completedAt: run.completedAt ?? now };
	}
	if (run.status === 'queued') {
		const deadline = run.startedAt + RUN_QUEUED_STARTUP_DEADLINE_MS;
		if (now >= deadline) {
			return { kind: 'abandon' };
		}
		return { kind: 'wait', waitMs: Math.min(deadline - now, MAX_SLEEP_MS) };
	}
	if (isClaimedRunStatus(run.status)) {
		if (!isRunClaimLeaseActive(run, now)) {
			return { kind: 'abandon' };
		}
		const expiresAt = run.claimExpiresAt ?? now;
		return { kind: 'wait', waitMs: Math.min(Math.max(expiresAt - now, 1), MAX_SLEEP_MS) };
	}
	return { kind: 'terminal', completedAt: run.completedAt ?? now };
}

export async function startRunLifecycle(ctx: MutationCtx, runId: Id<'runs'>): Promise<WorkflowId> {
	const deployment = await ctx.meta.getDeploymentMetadata();
	// convex-test shares JS globals with the workflow runtime. Starting a
	// workflow there deletes `process`/`crypto` and races later tests.
	if (deployment.name === 'test' && deployment.class === 's16') {
		// SAFETY: convex-test's dummy id is never passed to the workflow component.
		return 'test-workflow' as WorkflowId;
	}
	return await start(ctx, internal.runLifecycle.watchRun, { runId }, { startAsync: true });
}

export async function cancelRunLifecycle(ctx: MutationCtx, workflowId: string): Promise<void> {
	try {
		// SAFETY: stored run ids come from workflow.start() or the convex-test dummy.
		await cancel(ctx, components.workflow, workflowId as WorkflowId);
	} catch {
		// Already finished or never started.
	}
}

export const getWatchState = internalQuery({
	args: { runId: v.id('runs') },
	returns: v.union(
		v.object({ kind: v.literal('missing') }),
		v.object({ kind: v.literal('terminal'), completedAt: v.number() }),
		v.object({ kind: v.literal('abandon') }),
		v.object({ kind: v.literal('wait'), waitMs: v.number() })
	),
	handler: async (ctx, args) => {
		const run = await ctx.db.get('runs', args.runId);
		if (!run) {
			return { kind: 'missing' as const };
		}
		return watchStateForRun(run, Date.now());
	}
});

export const abandonExpiredRun = internalMutation({
	args: { runId: v.id('runs') },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const run = await ctx.db.get('runs', args.runId);
		if (!run || isRunFinalStatus(run.status)) {
			return false;
		}
		const state = watchStateForRun(run, Date.now());
		if (state.kind !== 'abandon') {
			return false;
		}
		return await finalizeRunRecord(ctx, run, {
			text: RUN_ABANDONED_BY_AGENT,
			status: 'failed',
			lastError: RUN_ABANDONED_BY_AGENT
		});
	}
});

export const reconcileTerminalPage = internalMutation({
	args: {
		runId: v.id('runs'),
		jobCursor: v.number(),
		questionCursor: v.number(),
		transcriptCursor: v.number()
	},
	returns: v.object({
		done: v.boolean(),
		jobCursor: v.number(),
		questionCursor: v.number(),
		transcriptCursor: v.number()
	}),
	handler: async (ctx, args) => {
		const run = await ctx.db.get('runs', args.runId);
		if (!run) {
			return {
				done: true,
				jobCursor: args.jobCursor,
				questionCursor: args.questionCursor,
				transcriptCursor: args.transcriptCursor
			};
		}
		return await advanceTerminalCleanup(ctx, {
			run,
			lastError: run.lastError,
			completedAt: run.completedAt ?? Date.now(),
			jobCursor: args.jobCursor,
			questionCursor: args.questionCursor,
			transcriptCursor: args.transcriptCursor
		});
	}
});

export const finishLifecycle = internalMutation({
	args: {
		runId: v.id('runs'),
		workflowId: vWorkflowId
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const run = await ctx.db.get('runs', args.runId);
		if (run?.lifecycleWorkflowId === args.workflowId) {
			await ctx.db.patch('runs', args.runId, { lifecycleWorkflowId: undefined });
		}
		// Do not cancel: returning from `watchRun` completes this workflow.
		// Canceling bumps generation while this step's onComplete still expects
		// the current one (`already has generation number 1 when completing`).
		return null;
	}
});

export const watchRun = defineWorkflow(components.workflow, {
	args: {
		runId: v.id('runs')
	}
}).handler(async (step, args) => {
	for (;;) {
		const state = await step.runQuery(internal.runLifecycle.getWatchState, {
			runId: args.runId
		});
		if (state.kind === 'missing') {
			return;
		}
		if (state.kind === 'abandon') {
			await step.runMutation(internal.runLifecycle.abandonExpiredRun, {
				runId: args.runId
			});
			continue;
		}
		if (state.kind === 'terminal') {
			let jobCursor = -1;
			let questionCursor = -1;
			let transcriptCursor = -1;
			for (;;) {
				const page = await step.runMutation(internal.runLifecycle.reconcileTerminalPage, {
					runId: args.runId,
					jobCursor,
					questionCursor,
					transcriptCursor
				});
				if (page.done) {
					break;
				}
				jobCursor = page.jobCursor;
				questionCursor = page.questionCursor;
				transcriptCursor = page.transcriptCursor;
			}
			await step.runMutation(internal.runLifecycle.finishLifecycle, {
				runId: args.runId,
				workflowId: step.workflowId
			});
			return;
		}
		await step.sleep(Math.max(state.waitMs, 1));
	}
});
