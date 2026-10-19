import { v, type Infer } from 'convex/values';
import {
	getRunExecutionState,
	getRunWithExecution,
	latestRunForThread
} from '@convex/lib/runExecution';
import { internal } from '@convex/_generated/api';
import { internalMutation, type MutationCtx } from '@convex/_generated/server';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { finalizeRunRecord } from '@convex/lib/runFinalize';
import { RUN_ABANDONED_BY_AGENT } from '@convex/lib/agentErrors';
import {
	AUTOMATIC_RECOVERY_SUBMISSION_PREFIX,
	isAutomaticallyRecoverableRun
} from '@convex/lib/runRecovery';
import { isRunFinalStatus } from '@convex/lib/validators';
import { CANCELLATION_FORCE_AFTER_MS, isRunCancellationOpen } from '@convex/lib/runCancellation';
import { runDeadline, scheduleRunLifecycleCheck } from '@convex/lib/runLifecycleSchedule';
import { cancelPendingQuestionsForThread } from '@convex/agentQuestions';
import {
	captureThreadActivityBeforeChange,
	updateThreadHierarchyAfterChange
} from '@convex/lib/threadHierarchy';

export async function startRunLifecycle(ctx: MutationCtx, runId: Id<'runs'>): Promise<void> {
	const run = await ctx.db.get('runs', runId);

	if (!run || isRunFinalStatus(run.status)) return;
	const state = await getRunExecutionState(ctx.db, runId);

	if (!state) throw new Error('Run execution state not found.');

	if (state.lifecycleCheckId) {
		const scheduled = await ctx.db.system.get('_scheduled_functions', state.lifecycleCheckId);

		if (scheduled?.state.kind === 'pending') return;
	}

	const deadline = runDeadline({
		...run,
		claimExpiresAt: state.claimExpiresAt
	});

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
	const current = await ctx.db.get('runs', run._id);

	if (!current) return false;

	const latest = await latestRunForThread(ctx.db, current.threadId);

	if (
		latest &&
		latest.continuationOfRunId === current._id &&
		latest.submissionId.startsWith(AUTOMATIC_RECOVERY_SUBMISSION_PREFIX)
	) {
		return await requestRunCancellation(ctx, latest);
	}

	const cancelledQuestions =
		latest?._id === current._id
			? await cancelPendingQuestionsForThread(ctx, current.threadId)
			: false;

	if (isRunFinalStatus(current.status)) {
		if (
			current.machineId !== undefined &&
			isAutomaticallyRecoverableRun(current, current.machineId)
		) {
			// A stopped abandoned run must stay terminal when its local agent returns.
			await ctx.db.patch('runs', current._id, { cancellationRequestedAt: Date.now() });

			return true;
		}

		return cancelledQuestions;
	}

	if (current.cancellationRequestedAt !== undefined) {
		return true;
	}

	const before = await captureThreadActivityBeforeChange(ctx, current.threadId);
	await ctx.db.patch('runs', current._id, { cancellationRequestedAt: Date.now() });
	await updateThreadHierarchyAfterChange(ctx, before);
	await ctx.scheduler.runAfter(CANCELLATION_FORCE_AFTER_MS, internal.runLifecycle.forceCancelRun, {
		runId: current._id
	});

	return true;
}

export async function requestThreadTreeCancellation(
	ctx: MutationCtx,
	thread: Doc<'threadRecords'>
): Promise<{ stoppedRunId?: Id<'runs'>; cancelled: boolean }> {
	const latest = await latestRunForThread(ctx.db, thread._id);

	const cancelled = latest
		? await requestRunCancellation(ctx, latest)
		: await cancelPendingQuestionsForThread(ctx, thread._id);

	const descendantsCancelled = await cancelDescendantsPage(ctx, {
		parentThreadId: thread._id,
		cursor: null
	});

	return { stoppedRunId: latest?._id, cancelled: cancelled || descendantsCancelled };
}

const vTreeCancellationBatch = v.object({
	parentThreadId: v.id('threadRecords'),
	cursor: v.union(v.string(), v.null()),
	// Ignored; carried by batches queued before the stateless sweep.
	rootThreadId: v.optional(v.id('threadRecords')),
	generation: v.optional(v.string())
});

// A thread's children are listed only after its own run is told to cancel, and
// a cancelling run cannot spawn subagents, so the top-down sweep needs no lock.
async function cancelDescendantsPage(
	ctx: MutationCtx,
	args: Infer<typeof vTreeCancellationBatch>
): Promise<boolean> {
	const parent = await ctx.db.get('threadRecords', args.parentThreadId);

	if (!parent) return false;

	const result = await ctx.db
		.query('threadRecords')
		.withIndex('by_userId_parentThreadId', (q) =>
			q.eq('userId', parent.userId).eq('parentThreadId', parent._id)
		)
		.order('desc')
		.paginate({
			numItems: 16,
			cursor: args.cursor,
			maximumRowsRead: 16,
			maximumBytesRead: 1024 * 1024
		});

	for (const child of result.page) {
		const latest = await latestRunForThread(ctx.db, child._id);

		if (latest) {
			await requestRunCancellation(ctx, latest);
		} else {
			await cancelPendingQuestionsForThread(ctx, child._id);
		}

		const grandchild = await ctx.db
			.query('threadRecords')
			.withIndex('by_userId_parentThreadId', (q) =>
				q.eq('userId', parent.userId).eq('parentThreadId', child._id)
			)
			.first();

		if (grandchild) {
			await ctx.scheduler.runAfter(0, internal.runLifecycle.cancelDescendants, {
				parentThreadId: child._id,
				cursor: null
			});
		}
	}

	if (!result.isDone) {
		await ctx.scheduler.runAfter(0, internal.runLifecycle.cancelDescendants, {
			parentThreadId: args.parentThreadId,
			cursor: result.continueCursor
		});
	}

	return result.page.length > 0;
}

export const cancelDescendants = internalMutation({
	args: vTreeCancellationBatch.fields,
	returns: v.null(),
	handler: async (ctx, args) => {
		await cancelDescendantsPage(ctx, args);

		return null;
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

		return await finalizeRunRecord(ctx, run, {
			text: '',
			status: 'cancelled'
		});
	}
});
