import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from './_generated/api';
import { createQueuedRun, initConvexTest, seedOwnedThread, seedThreadRecord } from './test.setup';
import { patchInboxThread } from './lib/inbox';
import { WEEK_MS } from './lib/inboxState';
import { setRunAndThreadStatus } from './lib/threadRunStatus';
import type { FunctionReturnType } from 'convex/server';

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-09-12T12:00:00Z'));
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});
const oneBatch = { cursor: null, dryRun: false, oneBatchOnly: true } as const;

describe('inbox lifecycle', () => {
	it('rejects undo when another device changed the snooze deadline', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const original = Date.now() + 3_600_000;
		await asUser.mutation(api.inbox.changeState, {
			threadId,
			state: 'snoozed',
			snoozedUntil: original
		});
		await asUser.mutation(api.inbox.changeState, {
			threadId,
			state: 'snoozed',
			snoozedUntil: original + 3_600_000
		});
		await expect(
			asUser.mutation(api.inbox.changeState, {
				threadId,
				state: 'active',
				expectedState: 'snoozed',
				expectedSnoozedUntil: original
			})
		).rejects.toThrow('Snooze changed elsewhere');
	});
	it('ignores stale legacy restore commands for pinned and snoozed threads', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		await asUser.mutation(api.inbox.changeState, { threadId, state: 'pinned' });
		await asUser.mutation(api.threads.restoreForLocalCache, { threadId });
		expect((await t.run((ctx) => ctx.db.get('threadRecords', threadId)))?.inboxState).toBe(
			'pinned'
		);
		await asUser.mutation(api.inbox.changeState, { threadId, state: 'active' });
		await asUser.mutation(api.inbox.changeState, {
			threadId,
			state: 'snoozed',
			snoozedUntil: Date.now() + 3_600_000
		});
		await asUser.mutation(api.threads.restoreForLocalCache, { threadId });
		expect((await t.run((ctx) => ctx.db.get('threadRecords', threadId)))?.inboxState).toBe(
			'snoozed'
		);
	});
	it('wakes on its timer without rewriting message activity or immediately settling', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const before = (await t.run((ctx) => ctx.db.get('threadRecords', threadId)))!;
		const until = Date.now() + 3_600_000;
		await asUser.mutation(api.inbox.changeState, {
			threadId,
			state: 'snoozed',
			snoozedUntil: until
		});
		await t.mutation(internal.inbox.wakeDue, {});
		expect((await t.run((ctx) => ctx.db.get('threadRecords', threadId)))?.inboxState).toBe(
			'snoozed'
		);
		vi.setSystemTime(until);
		await t.mutation(internal.inbox.wakeDue, {});
		await t.mutation(internal.inbox.maintain, {});
		expect(await t.run((ctx) => ctx.db.get('threadRecords', threadId))).toMatchObject({
			inboxState: 'active',
			lastMessageAt: before.lastMessageAt,
			inboxAutoSettleAt: until + WEEK_MS,
			wokeAt: until
		});
	});

	it('does not treat a repeated failure notification as a new wake event', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const run = await t.run(async (ctx) => {
			const run = (await ctx.db
				.query('runs')
				.withIndex('by_threadId_startedAt', (q) => q.eq('threadId', threadId))
				.first())!;
			await setRunAndThreadStatus(ctx, run, 'failed', { completedAt: Date.now() });
			return run;
		});
		await asUser.mutation(api.inbox.changeState, {
			threadId,
			state: 'snoozed',
			snoozedUntil: Date.now() + WEEK_MS
		});
		await t.run((ctx) => setRunAndThreadStatus(ctx, run, 'failed', { completedAt: Date.now() }));
		expect((await t.run((ctx) => ctx.db.get('threadRecords', threadId)))?.inboxState).toBe(
			'snoozed'
		);
	});

	it('measures inactivity from completion even when the prompt predates the settle window', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		await t.run((ctx) =>
			ctx.db.patch('threadRecords', threadId, { lastMessageAt: Date.now() - 3 * WEEK_MS })
		);
		await asUser.mutation(api.inbox.changeState, { threadId, state: 'active' });
		await t.mutation(internal.migrations.backfillInbox, oneBatch);
		await t.mutation(internal.inbox.maintain, {});
		expect(await t.run((ctx) => ctx.db.get('threadRecords', threadId))).toMatchObject({
			inboxState: 'active',
			inboxAutoSettleAt: Date.now() + WEEK_MS
		});
	});

	it('moves counts on rekey and does not double count sequential writes from an old snapshot', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		await t.run(async (ctx) => {
			const before = (await ctx.db.get('threadRecords', threadId))!;
			await patchInboxThread(ctx, before, { inboxState: 'pinned' });
			await patchInboxThread(ctx, before, { title: 'Renamed' });
			await patchInboxThread(ctx, before, { repositoryKey: 'other' });
		});
		const { projects } = await asUser.query(api.inbox.projects, {});
		expect(
			projects.reduce(
				(total, project) =>
					total + project.active + project.pinned + project.snoozed + project.settled,
				0
			)
		).toBe(1);
		expect(projects.find((project) => project.repositoryKey === 'other')?.pinned).toBe(1);
	});

	it('wakes for new input requests and refuses hiding unanswered questions', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'inbox-question';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'question-run',
			executionSecret,
			'Ask me'
		);
		const claimId = 'claim-inbox';
		await t.mutation(api.agentRuntime.start, { runId, claimId, executionSecret });
		await t.mutation(api.agentRuntime.beginToolJob, {
			runId,
			claimId,
			executionSecret,
			kind: 'ask_question',
			payload: { question: 'Choose?', options: [{ id: 'a', label: 'A' }] }
		});
		await asUser.mutation(api.inbox.changeState, {
			threadId,
			state: 'snoozed',
			snoozedUntil: Date.now() + WEEK_MS
		});
		const question = await t.mutation(api.agentQuestions.create, {
			runId,
			claimId,
			executionSecret,
			question: 'Choose?',
			options: [{ id: 'a', label: 'A' }]
		});
		expect(await t.run((ctx) => ctx.db.get('threadRecords', threadId))).toMatchObject({
			inboxState: 'active',
			hasPendingQuestion: true
		});
		await expect(
			asUser.mutation(api.inbox.changeState, {
				threadId,
				state: 'snoozed',
				snoozedUntil: Date.now() + WEEK_MS
			})
		).rejects.toThrow('waiting for your answer');
		await expect(
			asUser.mutation(api.inbox.changeState, { threadId, state: 'settled' })
		).rejects.toThrow('waiting for your answer');
		await asUser.mutation(api.agentQuestions.answer, {
			threadId,
			questionId: question.questionId,
			optionId: 'a'
		});
		expect((await t.run((ctx) => ctx.db.get('threadRecords', threadId)))?.hasPendingQuestion).toBe(
			false
		);
	});

	it('reactivates settled threads on a prompt but keeps pins pinned', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		await asUser.mutation(api.inbox.changeState, { threadId, state: 'settled' });
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'new-prompt',
			'secret',
			'New work'
		);
		expect((await t.run((ctx) => ctx.db.get('threadRecords', threadId)))?.inboxState).toBe(
			'active'
		);
		await asUser.mutation(api.inbox.changeState, { threadId, state: 'pinned' });
		await t.run(async (ctx) => {
			const run = (await ctx.db.get('runs', runId))!;
			await setRunAndThreadStatus(ctx, run, 'completed', { completedAt: Date.now() });
		});
		await createQueuedRun(t, asUser, threadId, 'pinned-prompt', 'secret', 'More work');
		expect((await t.run((ctx) => ctx.db.get('threadRecords', threadId)))?.inboxState).toBe(
			'pinned'
		);
	});
	it('migrates archived history and counts once without deleting records', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		await t.run((ctx) =>
			ctx.db.patch('threadRecords', threadId, {
				archivedAt: 100,
				lastMessageAt: 50,
				contextSummary: 'Keep me'
			})
		);
		await t.mutation(internal.migrations.backfillInbox, oneBatch);
		await t.mutation(internal.migrations.backfillInbox, oneBatch);
		const record = await t.run((ctx) => ctx.db.get('threadRecords', threadId));
		expect(record).toMatchObject({
			inboxState: 'settled',
			archivedAt: 100,
			lastMessageAt: 50,
			contextSummary: 'Keep me'
		});
		expect((await asUser.query(api.inbox.projects, {})).projects[0]?.settled).toBe(1);
	});
	it('protects pins through new and legacy actions, and unsetting updates activity', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		await asUser.mutation(api.inbox.changeState, { threadId, state: 'pinned' });
		await expect(
			asUser.mutation(api.inbox.changeState, {
				threadId,
				state: 'snoozed',
				snoozedUntil: Date.now() + 1000
			})
		).rejects.toThrow('Unpin');
		await expect(asUser.mutation(api.threads.archiveForLocalCache, { threadId })).rejects.toThrow(
			'Unpin'
		);
		await asUser.mutation(api.inbox.changeState, { threadId, state: 'active' });
		await asUser.mutation(api.inbox.changeState, { threadId, state: 'settled' });
		vi.setSystemTime(Date.now() + 1000);
		await asUser.mutation(api.inbox.changeState, { threadId, state: 'active' });
		const record = await t.run((ctx) => ctx.db.get('threadRecords', threadId));
		expect(record).toMatchObject({
			inboxState: 'active',
			lastMessageAt: Date.now(),
			inboxAutoSettleAt: Date.now() + WEEK_MS
		});
		expect(record?.archivedAt).toBeUndefined();
		expect((await asUser.query(api.inbox.projects, {})).projects[0]).toMatchObject({
			active: 1,
			pinned: 0,
			settled: 0,
			snoozed: 0
		});
	});
	it('allows a running thread to snooze, refuses settling, and wakes on completion', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const run = await t.run(async (ctx) => {
			const run = (await ctx.db
				.query('runs')
				.withIndex('by_threadId_startedAt', (q) => q.eq('threadId', threadId))
				.first())!;
			await setRunAndThreadStatus(ctx, run, 'running');
			return run;
		});
		await expect(
			asUser.mutation(api.inbox.changeState, { threadId, state: 'settled' })
		).rejects.toThrow('run is active');
		await asUser.mutation(api.inbox.changeState, {
			threadId,
			state: 'snoozed',
			snoozedUntil: Date.now() + WEEK_MS
		});
		await t.run((ctx) => setRunAndThreadStatus(ctx, run, 'completed', { completedAt: Date.now() }));
		expect(await t.run((ctx) => ctx.db.get('threadRecords', threadId))).toMatchObject({
			inboxState: 'active',
			wokeAt: Date.now(),
			lastCompletedAt: Date.now()
		});
	});
	it('auto-settles idle history but not pins or snoozes, and respects disabled settings', async () => {
		const t = initConvexTest();
		const { asUser, threadId, subject } = await seedOwnedThread(t);
		const pinned = await seedThreadRecord(t, subject, 'pins');
		await t.run(async (ctx) => {
			for (const id of [threadId, pinned]) {
				await ctx.db.patch('threadRecords', id, { lastMessageAt: Date.now() - 2 * WEEK_MS });
				const run = await ctx.db
					.query('runs')
					.withIndex('by_threadId_startedAt', (q) => q.eq('threadId', id))
					.first();
				if (run) await ctx.db.patch('runs', run._id, { completedAt: Date.now() - 2 * WEEK_MS });
			}
		});
		await t.mutation(internal.migrations.backfillInbox, oneBatch);
		await asUser.mutation(api.inbox.changeState, { threadId: pinned, state: 'pinned' });
		await asUser.mutation(api.inbox.setAutoSettle, { days: null });
		await t.mutation(internal.inbox.maintain, {});
		expect((await t.run((ctx) => ctx.db.get('threadRecords', threadId)))?.inboxState).toBe(
			'active'
		);
		await asUser.mutation(api.inbox.setAutoSettle, { days: 7 });
		await t.mutation(internal.inbox.rescheduleUser, { userId: subject });
		await t.mutation(internal.inbox.maintain, {});
		expect((await t.run((ctx) => ctx.db.get('threadRecords', threadId)))?.inboxState).toBe(
			'settled'
		);
		expect((await t.run((ctx) => ctx.db.get('threadRecords', pinned)))?.inboxState).toBe('pinned');
	});
	it('rejects another account and stale state transitions', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		await expect(
			t
				.withIdentity({ subject: 'other' })
				.mutation(api.inbox.changeState, { threadId, state: 'pinned' })
		).rejects.toThrow();
		await asUser.mutation(api.inbox.changeState, { threadId, state: 'pinned' });
		await expect(
			asUser.mutation(api.inbox.changeState, {
				threadId,
				state: 'active',
				expectedState: 'settled'
			})
		).rejects.toThrow('changed elsewhere');
	});
});

it('paginates all history with running-first ordering and merged project filters', async () => {
	const t = initConvexTest();
	const { asUser, subject } = await seedOwnedThread(t);
	for (let index = 0; index < 55; index++) {
		const id = await seedThreadRecord(t, subject, index % 2 ? 'beta' : 'gamma');
		await t.run(async (ctx) => {
			const thread = (await ctx.db.get('threadRecords', id))!;
			await patchInboxThread(ctx, thread, {
				lastMessageAt: index,
				status: index === 0 ? 'running' : 'completed'
			});
		});
	}
	const pages = [];
	let cursor: string | null = null;
	do {
		const result: FunctionReturnType<typeof api.inbox.list> = await asUser.query(api.inbox.list, {
			state: 'active',
			repositoryKeys: ['beta', 'gamma'],
			paginationOpts: { numItems: 10, cursor }
		});
		pages.push(...result.page);
		cursor = result.isDone ? null : result.continueCursor;
	} while (cursor);
	expect(pages).toHaveLength(55);
	expect(new Set(pages.map((row) => row._id)).size).toBe(55);
	expect(pages[0]?.lastMessageAt).toBe(0);
	expect(pages.slice(1).map((row) => row.lastMessageAt)).toEqual(
		Array.from({ length: 54 }, (_, index) => 54 - index)
	);
});
