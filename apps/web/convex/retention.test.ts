import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { changeThreadActivity, registerChildThread } from '@convex/lib/threadHierarchy';
import { RETENTION_MS } from '@convex/retention';
import {
	finishDueScheduledFunctions,
	initConvexTest,
	seedThreadRecord,
	type ConvexTestInstance
} from './test.setup';

const DAY_MS = 24 * 60 * 60 * 1_000;

const subject = 'user_alice';

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

	it('deletes trees idle for the retention period', async () => {
		const start = Date.now();
		const t = initConvexTest();

		await seedRoot(t, start - RETENTION_MS - DAY_MS);
		const recent = await seedRoot(t, start - 10 * DAY_MS);
		const working = await seedRoot(t, start - RETENTION_MS - DAY_MS);
		await setRunStatus(t, working, 'running');

		const replied = await seedRoot(t, start - RETENTION_MS - DAY_MS);
		await setRunStatus(t, replied, 'running');
		await setRunStatus(t, replied, 'completed');

		const parent = await seedRoot(t, start - RETENTION_MS - DAY_MS);
		const subagent = await seedThreadRecord(t, subject, 'alpha');
		await t.run(async (ctx) => {
			await ctx.db.patch('threadRecords', subagent, { parentThreadId: parent });
			await registerChildThread(ctx, (await ctx.db.get('threadRecords', subagent))!);
		});
		await setRunStatus(t, subagent, 'running');
		await setRunStatus(t, subagent, 'completed');

		await sweepAt(t, start);
		expect(await remainingThreads(t)).toEqual([recent, working, replied, parent, subagent]);

		await sweepAt(t, start + RETENTION_MS + DAY_MS);
		expect(await remainingThreads(t)).toEqual([working]);
	});
});
