import { defineWorkflow, vWorkflowId } from '@convex-dev/workflow';
import { v } from 'convex/values';
import {
	getRunExecutionState,
	getRunWithExecution,
	migrateRunExecution
} from '@convex/lib/runExecution';
import { components, internal } from '@convex/_generated/api';
import { internalMutation, internalQuery, type MutationCtx } from '@convex/_generated/server';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { RUN_QUEUED_STARTUP_DEADLINE_MS } from '@convex/lib/runLease';
import { advanceTerminalCleanup } from '@convex/lib/runTerminal';
import { finalizeRunRecord } from '@convex/lib/runFinalize';
import { RUN_ABANDONED_BY_AGENT } from '@convex/lib/agentErrors';
import { isRunFinalStatus } from '@convex/lib/validators';
import { CANCELLATION_FORCE_AFTER_MS, isRunCancellationOpen } from '@convex/lib/runCancellation';
import { runDeadline, scheduleRunLifecycleCheck } from '@convex/lib/runLifecycleSchedule';
const MAX_SLEEP_MS = RUN_QUEUED_STARTUP_DEADLINE_MS;

type RunWatchState =
	| { kind: 'terminal'; completedAt: number }
	| { kind: 'abandon' }
	| { kind: 'wait'; waitMs: number };

function watchStateForRun(run: Doc<'runs'>, now: number): RunWatchState {
	const deadline = runDeadline(run);
	if (deadline === null) {
		return { kind: 'terminal', completedAt: run.completedAt ?? now };
	}
	if (now >= deadline) return { kind: 'abandon' };
	return { kind: 'wait', waitMs: Math.min(deadline - now, MAX_SLEEP_MS) };
}

export async function startRunLifecycle(ctx: MutationCtx, runId: Id<'runs'>): Promise<void> {
	const run = await ctx.db.get('runs', runId);
	if (!run || isRunFinalStatus(run.status)) return;
	const stateId = await migrateRunExecution(ctx, run);
	const state = await ctx.db.get('runExecutionStates', stateId);
	if (!state) throw new Error('Run execution state not found.');
	if (state.lifecycleCheckId) {
		const scheduled = await ctx.db.system.get('_scheduled_functions', state.lifecycleCheckId);
		if (scheduled?.state.kind === 'pending') return;
	}
	const deadline = runDeadline({ ...run, claimExpiresAt: state.claimExpiresAt });
	if (deadline !== null) await scheduleRunLifecycleCheck(ctx, state, deadline);
}

export const checkRun = internalMutation({
	args: { runId: v.id('runs'), generation: v.number() },
	returns: v.null(),
	handler: async (ctx, { runId, generation }) => {
		const state = await getRunExecutionState(ctx.db, runId);
		if (!state?.lifecycleCheckId || state.lifecycleGeneration !== generation) return null;
		// Clear ownership before finalization so it cannot cancel this mutation's descendants.
		await ctx.db.patch('runExecutionStates', state._id, { lifecycleCheckId: undefined });
		const run = await getRunWithExecution(ctx.db, runId);
		if (!run) return null;
		const deadline = runDeadline(run);
		if (deadline === null) return null;
		if (deadline > Date.now()) {
			await scheduleRunLifecycleCheck(ctx, state, deadline);
		} else {
			await finalizeRunRecord(ctx, run, {
				text: RUN_ABANDONED_BY_AGENT,
				status: 'failed',
				lastError: RUN_ABANDONED_BY_AGENT
			});
		}
		return null;
	}
});

export async function requestRunCancellation(ctx: MutationCtx, run: Doc<'runs'>): Promise<boolean> {
	if (isRunFinalStatus(run.status)) {
		return false;
	}
	if (run.cancellationRequestedAt !== undefined) {
		return true;
	}
	const now = Date.now();
	await ctx.db.patch('runs', run._id, {
		cancellationRequestedAt: now,
		cancellationDeadlineAt: now + CANCELLATION_FORCE_AFTER_MS
	});
	await ctx.scheduler.runAfter(CANCELLATION_FORCE_AFTER_MS, internal.runLifecycle.forceCancelRun, {
		runId: run._id
	});
	return true;
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
		const run = await getRunWithExecution(ctx.db, args.runId);
		if (!run?.lifecycleWorkflowId) {
			return { kind: 'missing' as const };
		}
		return watchStateForRun(run, Date.now());
	}
});

export const abandonExpiredRun = internalMutation({
	args: { runId: v.id('runs') },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const run = await getRunWithExecution(ctx.db, args.runId);
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

export const forceCancelRun = internalMutation({
	args: { runId: v.id('runs') },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const run = await getRunWithExecution(ctx.db, args.runId);
		if (!run || !isRunCancellationOpen(run)) {
			return false;
		}
		const now = Date.now();
		if (run.cancellationDeadlineAt !== undefined && now < run.cancellationDeadlineAt) {
			return false;
		}
		return await finalizeRunRecord(ctx, run, {
			text: '',
			status: 'cancelled'
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
		const run = await getRunWithExecution(ctx.db, args.runId);
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
