import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import { getRunExecutionState, patchRunExecution } from '@convex/lib/runExecution';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';

const oneBatch = { cursor: null, dryRun: false, oneBatchOnly: true } as const;

describe('native lifecycle migration', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('hands off a live legacy workflow without changing its lease or creating duplicate checks', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'lifecycle-migration-secret';
		const { runId } = await createQueuedRun(t, asUser, threadId, 'handoff', executionSecret);
		await asUser.mutation(api.agentRuntime.start, { runId, executionSecret, claimId: 'live' });
		const lease = await t.run(async (ctx) => {
			const state = await getRunExecutionState(ctx.db, runId);
			if (!state?.lifecycleCheckId) throw new Error('Missing native check.');
			await ctx.scheduler.cancel(state.lifecycleCheckId);
			await ctx.db.patch('runExecutionStates', state._id, {
				lifecycleCheckId: undefined,
				lifecycleGeneration: undefined
			});
			await ctx.db.patch('runs', runId, { lifecycleWorkflowId: 'legacy-workflow' });
			return state.claimExpiresAt;
		});
		expect(await t.query(internal.runLifecycle.getWatchState, { runId })).toMatchObject({
			kind: 'wait'
		});
		await t.mutation(internal.migrations.migrateRunLifecycle, oneBatch);
		const state = await t.run((ctx) => getRunExecutionState(ctx.db, runId));
		expect(state).toMatchObject({ claimId: 'live', claimExpiresAt: lease, lifecycleGeneration: 1 });
		if (!state?.lifecycleCheckId) throw new Error('Missing migrated check.');
		const scheduledId = state.lifecycleCheckId;
		expect(
			await t.run((ctx) => ctx.db.system.get('_scheduled_functions', scheduledId))
		).toMatchObject({ scheduledTime: lease, state: { kind: 'pending' } });
		expect(await t.query(internal.runLifecycle.getWatchState, { runId })).toEqual({
			kind: 'missing'
		});
		await t.mutation(internal.migrations.migrateRunLifecycle, oneBatch);
		expect(await t.run((ctx) => getRunExecutionState(ctx.db, runId))).toEqual(state);
		expect(await t.run((ctx) => ctx.db.get('runs', runId))).toMatchObject({ status: 'running' });
	});

	it('repairs a missing legacy watcher and honors execution state instead of stale run fields', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const { runId } = await createQueuedRun(t, asUser, threadId, 'repair', 'repair-secret');
		const deadline = Date.now() + 90_000;
		await t.run(async (ctx) => {
			const state = await getRunExecutionState(ctx.db, runId);
			if (!state?.lifecycleCheckId) throw new Error('Missing native check.');
			await ctx.scheduler.cancel(state.lifecycleCheckId);
			await ctx.db.patch('runExecutionStates', state._id, { lifecycleCheckId: undefined });
			await patchRunExecution(ctx, runId, { claimId: 'current', claimExpiresAt: deadline });
			await ctx.db.patch('runs', runId, {
				status: 'awaiting_executor',
				claimId: 'stale',
				claimExpiresAt: Date.now() - 1
			});
		});
		await t.mutation(internal.migrations.migrateRunLifecycle, oneBatch);
		const state = await t.run((ctx) => getRunExecutionState(ctx.db, runId));
		if (!state?.lifecycleCheckId) throw new Error('Missing repaired check.');
		const scheduledId = state.lifecycleCheckId;
		expect(
			await t.run((ctx) => ctx.db.system.get('_scheduled_functions', scheduledId))
		).toMatchObject({ scheduledTime: deadline });
		expect(state.claimId).toBe('current');
	});

	it('clears completed runs without scheduling new lifecycle work', async () => {
		const t = initConvexTest();
		const { threadId } = await seedOwnedThread(t);
		const runId = await t.run(async (ctx) => {
			const run = await ctx.db
				.query('runs')
				.withIndex('by_threadId_startedAt', (q) => q.eq('threadId', threadId))
				.unique();
			if (!run) throw new Error('Missing fixture run.');
			await ctx.db.patch('runs', run._id, { lifecycleWorkflowId: 'finished-workflow' });
			return run._id;
		});
		await t.mutation(internal.migrations.migrateRunLifecycle, oneBatch);
		expect(await t.run((ctx) => ctx.db.get('runs', runId))).not.toHaveProperty(
			'lifecycleWorkflowId'
		);
		expect(await t.run((ctx) => getRunExecutionState(ctx.db, runId))).toBeNull();
		expect(await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())).toEqual([]);
	});
});
