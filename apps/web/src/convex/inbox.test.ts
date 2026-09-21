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

	it('lists queued and running threads first, then by lastMessageAt', async () => {
		const t = initConvexTest();
		const { asUser, subject, threadId: idleNewer } = await seedOwnedThread(t);
		const idleOlder = await seedThreadRecord(t, subject, 'beta');
		const queuedOlder = await seedThreadRecord(t, subject, 'gamma');
		const runningNewer = await seedThreadRecord(t, subject, 'delta');
		const failedNewest = await seedThreadRecord(t, subject, 'epsilon');
		await t.run(async (ctx) => {
			await ctx.db.patch('threadRecords', idleNewer, { lastMessageAt: 40 });
			await ctx.db.patch('threadRecords', idleOlder, { lastMessageAt: 10 });
			await ctx.db.patch('threadRecords', queuedOlder, {
				lastMessageAt: 20,
				status: 'queued'
			});
			await ctx.db.patch('threadRecords', runningNewer, {
				lastMessageAt: 30,
				status: 'running'
			});
			await ctx.db.patch('threadRecords', failedNewest, {
				lastMessageAt: 50,
				status: 'failed'
			});
		});

		const page = await asUser.query(api.inbox.list, {
			state: 'unsettled',
			repositoryKeys: ['alpha', 'beta', 'gamma', 'delta', 'epsilon'],
			paginationOpts: { numItems: 10, cursor: null }
		});

		expect(page.page.map((thread) => thread._id)).toEqual([
			runningNewer,
			queuedOlder,
			failedNewest,
			idleNewer,
			idleOlder
		]);
	});

	it('keeps queued and running threads first across pages', async () => {
		const t = initConvexTest();
		const { asUser, subject, threadId: idle } = await seedOwnedThread(t);
		const running = await seedThreadRecord(t, subject, 'beta');
		await t.run(async (ctx) => {
			await ctx.db.patch('threadRecords', idle, { lastMessageAt: 40 });
			await ctx.db.patch('threadRecords', running, {
				lastMessageAt: 10,
				status: 'running'
			});
		});

		const first = await asUser.query(api.inbox.list, {
			state: 'unsettled',
			repositoryKeys: ['alpha', 'beta'],
			paginationOpts: { numItems: 1, cursor: null }
		});
		const second = await asUser.query(api.inbox.list, {
			state: 'unsettled',
			repositoryKeys: ['alpha', 'beta'],
			paginationOpts: { numItems: 1, cursor: first.continueCursor }
		});

		expect(first.page.map((thread) => thread._id)).toEqual([running]);
		expect(second.page.map((thread) => thread._id)).toEqual([idle]);
	});

	it('orders settled threads by settlement time regardless of status', async () => {
		const t = initConvexTest();
		const { asUser, subject, threadId: olderRunning } = await seedOwnedThread(t);
		const newerIdle = await seedThreadRecord(t, subject, 'beta');
		await t.run(async (ctx) => {
			await ctx.db.patch('threadRecords', olderRunning, {
				archivedAt: 10,
				status: 'running'
			});
			await ctx.db.patch('threadRecords', newerIdle, { archivedAt: 20 });
		});

		const page = await asUser.query(api.inbox.list, {
			state: 'settled',
			repositoryKeys: ['alpha', 'beta'],
			paginationOpts: { numItems: 10, cursor: null }
		});

		expect(page.page.map((thread) => thread._id)).toEqual([newerIdle, olderRunning]);
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

	it('accepts 200 distinct projects after removing duplicates', async () => {
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		const repositoryKeys = Array.from({ length: 200 }, (_, index) => `project-${index}`);

		const result = await asUser.query(api.inbox.list, {
			state: 'unsettled',
			repositoryKeys: [...repositoryKeys, ...repositoryKeys],
			paginationOpts: { numItems: 10, cursor: null }
		});

		expect(result.page).toEqual([]);
	});

	it('rejects enough projects to exhaust query resources', async () => {
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		const repositoryKeys = Array.from({ length: 201 }, (_, index) => `project-${index}`);

		await expect(
			asUser.query(api.inbox.list, {
				state: 'unsettled',
				repositoryKeys,
				paginationOpts: { numItems: 10, cursor: null }
			})
		).rejects.toThrow('Choose at most 200 projects.');
	});

	it('settles and unsettles an idle thread', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);

		await asUser.mutation(api.threads.settle, { threadId });
		expect((await t.run((ctx) => ctx.db.get('threadRecords', threadId)))?.archivedAt).toBeTypeOf(
			'number'
		);

		await asUser.mutation(api.threads.unsettle, { threadId });
		expect(
			(await t.run((ctx) => ctx.db.get('threadRecords', threadId)))?.archivedAt
		).toBeUndefined();
	});

	it('refuses to settle a running thread', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		await t.run((ctx) => ctx.db.patch('threadRecords', threadId, { status: 'running' }));

		await expect(asUser.mutation(api.threads.settle, { threadId })).rejects.toThrow(
			'running thread'
		);
	});

	it('settles a queued thread', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		await t.run((ctx) => ctx.db.patch('threadRecords', threadId, { status: 'queued' }));

		await asUser.mutation(api.threads.settle, { threadId });

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
				toolInvocationId: 'test-invocation-inbox-question',
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

		await asUser.mutation(api.threads.settle, { threadId });

		expect((await t.run((ctx) => ctx.db.get('threadRecords', threadId)))?.archivedAt).toBeTypeOf(
			'number'
		);
	});

	it('rejects state changes from another account', async () => {
		const t = initConvexTest();
		const { threadId } = await seedOwnedThread(t, 'user_alice');

		await expect(
			t.withIdentity({ subject: 'user_bob' }).mutation(api.threads.settle, { threadId })
		).rejects.toThrow();
	});
});
