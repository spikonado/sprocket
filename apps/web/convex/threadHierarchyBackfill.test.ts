import { describe, expect, it, vi } from 'vitest';
import { internal } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import {
	refreshThreadHierarchyActivity,
	registerChildThread,
	subtreeSummary
} from '@convex/lib/threadHierarchy';
import { setRunAndThreadStatus } from '@convex/lib/threadRunStatus';
import { initConvexTest, seedOwnedThread, type ConvexTestInstance } from './test.setup';

const zeroCounts = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };

async function thread(
	t: ConvexTestInstance,
	status: Doc<'threadRecords'>['status'],
	parentThreadId?: Id<'threadRecords'>
) {
	const { threadId } = await seedOwnedThread(t);

	const runId = await t.run(async (ctx) => {
		const run = (await ctx.db
			.query('runs')
			.withIndex('by_threadId_startedAt', (q) => q.eq('threadId', threadId))
			.unique())!;

		await ctx.db.patch('threadRecords', threadId, { status, parentThreadId });
		await ctx.db.patch('runs', run._id, { status });

		if (parentThreadId) {
			await registerChildThread(ctx, (await ctx.db.get('threadRecords', threadId))!);
		} else {
			await refreshThreadHierarchyActivity(ctx, threadId);
		}

		return run._id;
	});

	return { threadId, runId };
}

async function makeLegacy(t: ConvexTestInstance) {
	await t.run(async (ctx) => {
		for (const row of await ctx.db.query('threadHierarchyStates').collect()) {
			await ctx.db.patch('threadHierarchyStates', row._id, {
				ownStatus: undefined,
				descendantStatusCounts: undefined
			});
		}
	});
}

async function snapshot(t: ConvexTestInstance) {
	return await t.run(async (ctx) => ({
		threads: await ctx.db.query('threadRecords').collect(),
		states: await ctx.db.query('threadHierarchyStates').collect()
	}));
}

async function summary(t: ConvexTestInstance, threadId: Id<'threadRecords'>) {
	return await t.run(async (ctx) =>
		subtreeSummary(ctx.db, (await ctx.db.get('threadRecords', threadId))!)
	);
}

async function oneBatch(t: ConvexTestInstance, cursor: string | null) {
	return await t.mutation(internal.migrations.backfillThreadHierarchyStatuses, {
		cursor,
		dryRun: false,
		oneBatchOnly: true
	});
}

async function finishBatches(t: ConvexTestInstance, cursor: string | null = null) {
	for (;;) {
		const result = await oneBatch(t, cursor);

		if (result.isDone) return;
		cursor = result.continueCursor;
	}
}

async function transition(t: ConvexTestInstance, runId: Id<'runs'>, status: Doc<'runs'>['status']) {
	await t.run(async (ctx) =>
		setRunAndThreadStatus(ctx, (await ctx.db.get('runs', runId))!, status)
	);
}

describe('thread hierarchy status backfill', () => {
	it('fills legacy nested counts while preserving existing fields and remains idempotent', async () => {
		const t = initConvexTest();
		const root = await thread(t, 'completed');
		const branch = await thread(t, 'queued', root.threadId);
		await thread(t, 'running', branch.threadId);
		await thread(t, 'completed', root.threadId);
		await thread(t, 'failed', root.threadId);
		await thread(t, 'cancelled', root.threadId);
		await makeLegacy(t);

		const before = await snapshot(t);

		expect(await summary(t, root.threadId)).toEqual({
			descendantCount: 5,
			anyActive: true,
			descendantsActive: true,
			descendantStatusCounts: zeroCounts
		});
		await finishBatches(t);
		expect(await summary(t, root.threadId)).toEqual({
			descendantCount: 5,
			anyActive: true,
			descendantsActive: true,
			descendantStatusCounts: { queued: 1, running: 1, completed: 1, failed: 1, cancelled: 1 }
		});
		expect(await summary(t, branch.threadId)).toEqual({
			descendantCount: 1,
			anyActive: true,
			descendantsActive: true,
			descendantStatusCounts: { ...zeroCounts, running: 1 }
		});

		const after = await snapshot(t);

		expect(after.threads).toEqual(before.threads);

		for (const previous of before.states) {
			const row = after.states.find((state) => state._id === previous._id)!;

			expect(row).toMatchObject(previous);
			expect(row.ownStatus).toBe(
				after.threads.find((record) => record._id === row.threadId)!.status
			);
			expect(row.descendantStatusCounts).toBeDefined();
		}

		await finishBatches(t);
		expect(await snapshot(t)).toEqual(after);
	});

	it('handles live transitions and a new child between migration batches', async () => {
		const t = initConvexTest();
		const root = await thread(t, 'completed');
		const branch = await thread(t, 'completed', root.threadId);
		const leaf = await thread(t, 'queued', branch.threadId);
		await makeLegacy(t);

		const first = await oneBatch(t, null);
		const second = await oneBatch(t, first.continueCursor);

		expect(first).toMatchObject({ processed: 1, isDone: false });
		expect(second).toMatchObject({ processed: 1, isDone: false });
		await transition(t, branch.runId, 'failed');
		await transition(t, leaf.runId, 'running');
		await thread(t, 'completed', branch.threadId);
		expect(await summary(t, root.threadId)).toEqual({
			descendantCount: 3,
			anyActive: true,
			descendantsActive: true,
			descendantStatusCounts: { queued: 0, running: 1, completed: 1, failed: 1, cancelled: 0 }
		});

		const third = await oneBatch(t, second.continueCursor);

		expect(third.processed).toBe(1);
		await transition(t, leaf.runId, 'completed');
		await finishBatches(t, third.continueCursor);
		expect(await summary(t, root.threadId)).toEqual({
			descendantCount: 3,
			anyActive: false,
			descendantsActive: false,
			descendantStatusCounts: { ...zeroCounts, completed: 2, failed: 1 }
		});
		expect(await summary(t, branch.threadId)).toEqual({
			descendantCount: 2,
			anyActive: false,
			descendantsActive: false,
			descendantStatusCounts: { ...zeroCounts, completed: 2 }
		});
	});

	it('records automatic runner completion and leaves completed schedules unchanged', async () => {
		vi.useFakeTimers();

		try {
			const t = initConvexTest();
			const root = await thread(t, 'completed');
			await thread(t, 'cancelled', root.threadId);
			await makeLegacy(t);
			await t.mutation(internal.migrations.runThreadHierarchyStatusBackfillAutomatically, {});
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			await t.mutation(internal.migrations.runThreadHierarchyStatusBackfillAutomatically, {});

			const schedule = await t.run((ctx) => ctx.db.query('migrationSchedules').unique());

			expect(schedule).toMatchObject({
				name: 'thread-hierarchy-status-counts-2026-10',
				startedAt: expect.any(Number),
				completedAt: expect.any(Number)
			});
			expect((await summary(t, root.threadId)).descendantStatusCounts).toEqual({
				...zeroCounts,
				cancelled: 1
			});

			const after = await snapshot(t);

			vi.setSystemTime(Date.now() + 1000);
			await t.mutation(internal.migrations.runThreadHierarchyStatusBackfillAutomatically, {});
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			expect(await t.run((ctx) => ctx.db.query('migrationSchedules').unique())).toEqual(schedule);
			expect(await snapshot(t)).toEqual(after);
		} finally {
			vi.useRealTimers();
		}
	});
});
