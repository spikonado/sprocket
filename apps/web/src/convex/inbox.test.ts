import { describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import { initConvexTest, seedOwnedThread, seedThreadRecord } from './test.setup';

describe('thread inbox', () => {
	it('paginates unsettled and settled threads across selected projects', async () => {
		const t = initConvexTest();
		const { asUser, subject, threadId } = await seedOwnedThread(t);
		const second = await seedThreadRecord(t, subject, 'beta');
		const excluded = await seedThreadRecord(t, subject, 'excluded');
		await t.run(async (ctx) => {
			await ctx.db.patch('threadRecords', threadId, { lastMessageAt: 10 });
			await ctx.db.patch('threadRecords', second, { lastMessageAt: 20, archivedAt: 30 });
			await ctx.db.patch('threadRecords', excluded, { lastMessageAt: 40 });
		});

		const unsettled = await asUser.query(api.inbox.list, {
			state: 'unsettled',
			repositoryKeys: ['alpha', 'beta'],
			paginationOpts: { numItems: 10, cursor: null }
		});
		const settled = await asUser.query(api.inbox.list, {
			state: 'settled',
			repositoryKeys: ['alpha', 'beta'],
			paginationOpts: { numItems: 10, cursor: null }
		});

		expect(unsettled.page.map((thread) => thread._id)).toEqual([threadId]);
		expect(settled.page.map((thread) => thread._id)).toEqual([second]);
	});

	it('keeps another account out of the requested project stream', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'user_alice');
		await seedThreadRecord(t, 'user_bob', 'alpha');

		const result = await asUser.query(api.inbox.list, {
			state: 'unsettled',
			repositoryKeys: ['alpha'],
			paginationOpts: { numItems: 10, cursor: null }
		});

		expect(result.page.map((thread) => thread._id)).toEqual([threadId]);
	});

	it('accepts more than 100 attached projects in the global view', async () => {
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		const repositoryKeys = Array.from({ length: 101 }, (_, index) => `project-${index}`);

		const result = await asUser.query(api.inbox.list, {
			state: 'unsettled',
			repositoryKeys,
			paginationOpts: { numItems: 10, cursor: null }
		});

		expect(result.page).toEqual([]);
	});

	it('settles and unsettles an idle thread', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);

		await asUser.mutation(api.threads.settleForLocalCache, { threadId });
		expect((await t.run((ctx) => ctx.db.get('threadRecords', threadId)))?.archivedAt).toBeTypeOf(
			'number'
		);

		await asUser.mutation(api.threads.unsettleForLocalCache, { threadId });
		expect(
			(await t.run((ctx) => ctx.db.get('threadRecords', threadId)))?.archivedAt
		).toBeUndefined();
	});

	it('refuses to settle a running thread', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		await t.run((ctx) => ctx.db.patch('threadRecords', threadId, { status: 'running' }));

		await expect(asUser.mutation(api.threads.settleForLocalCache, { threadId })).rejects.toThrow(
			'running thread'
		);
	});

	it('settles a queued thread', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		await t.run((ctx) => ctx.db.patch('threadRecords', threadId, { status: 'queued' }));

		await asUser.mutation(api.threads.settleForLocalCache, { threadId });

		expect((await t.run((ctx) => ctx.db.get('threadRecords', threadId)))?.archivedAt).toBeTypeOf(
			'number'
		);
	});

	it('settles a thread with a pending question', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		await t.run(async (ctx) => {
			const run = await ctx.db
				.query('runs')
				.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', threadId))
				.first();
			if (!run) throw new Error('Missing fixture run.');
			const jobId = await ctx.db.insert('executorJobs', {
				threadId,
				runId: run._id,
				kind: 'ask_question',
				payload: { question: 'Choose?', options: [] },
				hidden: false,
				status: 'claimed',
				enqueuedAt: 1,
				sequence: 1
			});
			await ctx.db.insert('agentQuestions', {
				threadId,
				runId: run._id,
				jobId,
				question: 'Choose?',
				options: [],
				status: 'pending',
				createdAt: 1,
				timeoutAt: 2,
				sequence: 1
			});
		});

		await asUser.mutation(api.threads.settleForLocalCache, { threadId });

		expect((await t.run((ctx) => ctx.db.get('threadRecords', threadId)))?.archivedAt).toBeTypeOf(
			'number'
		);
	});

	it('rejects state changes from another account', async () => {
		const t = initConvexTest();
		const { threadId } = await seedOwnedThread(t, 'user_alice');

		await expect(
			t
				.withIdentity({ subject: 'user_bob' })
				.mutation(api.threads.settleForLocalCache, { threadId })
		).rejects.toThrow();
	});
});
