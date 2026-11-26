import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { changeThreadActivity, registerChildThread } from '@convex/lib/threadHierarchy';
import { RETENTION_GRACE_MS } from '@convex/retention';
import {
	finishDueScheduledFunctions,
	initConvexTest,
	seedThreadRecord,
	seedTiers,
	type ConvexTestInstance
} from './test.setup';

const DAY_MS = 24 * 60 * 60 * 1_000;

const subject = 'user_alice';

async function setFreeRetention(t: ConvexTestInstance, retentionDays: number) {
	await t.run(async (ctx) => {
		const free = await ctx.db
			.query('tiers')
			.withIndex('by_tierId', (query) => query.eq('tierId', 'free'))
			.unique();

		await ctx.db.patch('tiers', free!._id, { retentionDays });
	});
}

async function seedRoot(t: ConvexTestInstance, lastMessageAt: number) {
	const threadId = await seedThreadRecord(t, subject, 'alpha');
	await t.run((ctx) => ctx.db.patch('threadRecords', threadId, { lastMessageAt }));

	return threadId;
}

async function sweepAt(t: ConvexTestInstance, now: number) {
	vi.setSystemTime(now);
	await t.mutation(internal.retention.sweep, {});
	await finishDueScheduledFunctions(t);
}

async function remainingThreads(t: ConvexTestInstance) {
	return await t.run(async (ctx) =>
		(await ctx.db.query('threadRecords').collect()).map((thread) => thread._id)
	);
}

async function setRunStatus(
	t: ConvexTestInstance,
	threadId: Id<'threadRecords'>,
	status: 'running' | 'completed'
) {
	await t.run(async (ctx) => {
		const run = await ctx.db
			.query('runs')
			.withIndex('by_threadId', (query) => query.eq('threadId', threadId))
			.unique();

		await changeThreadActivity(ctx, threadId, () => ctx.db.patch('runs', run!._id, { status }));
	});
}

describe('retention sweep', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('deletes idle trees past the plan limit after each shortening grace period', async () => {
		const start = Date.now();
		const t = initConvexTest();
		await seedTiers(t);
		await setFreeRetention(t, 30);

		const old = await seedRoot(t, start - 40 * DAY_MS);
		const recent = await seedRoot(t, start - 10 * DAY_MS);
		const working = await seedRoot(t, start - 40 * DAY_MS);
		await setRunStatus(t, working, 'running');

		const parent = await seedRoot(t, start - 40 * DAY_MS);
		const subagent = await seedThreadRecord(t, subject, 'alpha');
		await t.run(async (ctx) => {
			await ctx.db.patch('threadRecords', subagent, { parentThreadId: parent });
			await registerChildThread(ctx, (await ctx.db.get('threadRecords', subagent))!);
		});
		await setRunStatus(t, subagent, 'running');
		await setRunStatus(t, subagent, 'completed');

		await sweepAt(t, start);
		expect(await remainingThreads(t)).toEqual([old, recent, working, parent, subagent]);

		const afterGrace = start + RETENTION_GRACE_MS + DAY_MS;
		await sweepAt(t, afterGrace);
		expect(await remainingThreads(t)).toEqual([recent, working, parent, subagent]);

		await setFreeRetention(t, 7);
		await sweepAt(t, afterGrace + DAY_MS);
		expect(await remainingThreads(t)).toEqual([recent, working, parent, subagent]);

		await sweepAt(t, afterGrace + 2 * DAY_MS + RETENTION_GRACE_MS);
		expect(await remainingThreads(t)).toEqual([working]);
	});
});
