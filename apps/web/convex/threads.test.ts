import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@convex/_generated/api';
import {
	createQueuedRun,
	finishDueScheduledFunctions,
	initConvexTest,
	insertDraftFile,
	readThread,
	seedOwnedThread,
	seedThreadRecord
} from './test.setup';

describe('thread mutations', () => {
	it('lists unsettled, then settled root threads of the run project for agents', async () => {
		const t = initConvexTest();
		const { asUser, subject, threadId } = await seedOwnedThread(t);
		const settled = await seedThreadRecord(t, subject, 'alpha');
		const child = await seedThreadRecord(t, subject, 'alpha');
		await seedThreadRecord(t, subject, 'beta');
		await t.run(async (ctx) => {
			await ctx.db.patch('threadRecords', settled, { archivedAt: 1 });
			await ctx.db.patch('threadRecords', child, { parentThreadId: threadId });
		});
		const executionSecret = 'list-threads-secret';
		const { runId } = await createQueuedRun(t, asUser, threadId, 'list', executionSecret);
		const base = { runId, executionSecret, includeSettled: true };

		const unsettled = await t.query(api.threads.listForRun, base);

		const rest = await t.query(api.threads.listForRun, {
			...base,
			cursor: unsettled.nextCursor ?? undefined
		});

		const children = await t.query(api.threads.listForRun, {
			runId,
			executionSecret,
			parentThreadId: threadId
		});

		expect(unsettled.threads.map((thread) => thread.threadId)).toEqual([threadId]);
		expect(rest).toMatchObject({
			threads: [{ threadId: settled, settled: true }],
			nextCursor: null
		});
		expect(children.threads.map((thread) => thread.threadId)).toEqual([child]);
	});

	it('searches titles across the chosen projects and within a parent', async () => {
		const t = initConvexTest();
		const { asUser, subject, threadId } = await seedOwnedThread(t);
		const child = await seedThreadRecord(t, subject, 'alpha');
		const beta = await seedThreadRecord(t, subject, 'beta');
		await seedThreadRecord(t, subject, 'gamma');
		await t.run(async (ctx) => {
			const records = await ctx.db.query('threadRecords').collect();

			for (const record of records) {
				await ctx.db.patch('threadRecords', record._id, { title: 'Fix the radio' });
			}

			await ctx.db.patch('threadRecords', child, { parentThreadId: threadId });
		});
		const executionSecret = 'search-threads-secret';
		const { runId } = await createQueuedRun(t, asUser, threadId, 'search', executionSecret);
		const base = { runId, executionSecret, query: 'radio' };

		const roots = await t.query(api.threads.listForRun, {
			...base,
			repositoryKeys: ['alpha', 'beta']
		});

		const children = await t.query(api.threads.listForRun, { ...base, parentThreadId: threadId });

		expect(roots.threads.map((thread) => thread.threadId).sort()).toEqual([threadId, beta].sort());
		expect(children.threads.map((thread) => thread.threadId)).toEqual([child]);
	});

	it('supports direct mutations', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		await expect(
			asUser.mutation(api.threads.rename, { threadId, title: 'Renamed directly' })
		).resolves.toBeNull();
		expect((await readThread(asUser, threadId)).title).toBe('Renamed directly');
		await expect(asUser.mutation(api.threads.settle, { threadId })).resolves.toBeNull();
		expect((await readThread(asUser, threadId)).archivedAt).toBeDefined();
		await expect(asUser.mutation(api.threads.unsettle, { threadId })).resolves.toBeNull();
		expect((await readThread(asUser, threadId)).archivedAt).toBeUndefined();
	});

	it('moves a thread tree to another project and resets its cwd', async () => {
		const t = initConvexTest();
		const { asUser, subject, threadId } = await seedOwnedThread(t);

		const grandchildId = await t.run(async (ctx) => {
			await ctx.db.patch('threadRecords', threadId, { cwd: '/alpha/sub' });
			await ctx.db.insert('threadHierarchyStates', {
				threadId,
				descendantCount: 2,
				workingDescendantCount: 0,
				activeDescendantCount: 0
			});

			const child = {
				userId: subject,
				status: 'completed',
				repositoryKey: 'alpha',
				cwd: '/alpha/sub',
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				fastMode: false,
				lastMessageAt: Date.now()
			} as const;

			const childId = await ctx.db.insert('threadRecords', { ...child, parentThreadId: threadId });

			return await ctx.db.insert('threadRecords', { ...child, parentThreadId: childId });
		});

		await asUser.mutation(api.threads.moveToProject, { threadId, repositoryKey: 'beta' });

		for (const id of [threadId, grandchildId]) {
			const moved = await t.run(async (ctx) => await ctx.db.get('threadRecords', id));
			expect(moved?.repositoryKey).toBe('beta');
			expect(moved?.cwd).toBeUndefined();
		}
	});
});

describe('thread deletion', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('deletes the whole tree with its run data and files in batches', async () => {
		vi.useFakeTimers();
		const t = initConvexTest();
		const { asUser, subject, threadId } = await seedOwnedThread(t);
		const other = await seedThreadRecord(t, subject, 'alpha');

		const children = await Promise.all(
			Array.from({ length: 17 }, () => seedThreadRecord(t, subject, 'alpha'))
		);

		const grandchild = await seedThreadRecord(t, subject, 'alpha');
		await t.run(async (ctx) => {
			for (const child of children) {
				await ctx.db.patch('threadRecords', child, { parentThreadId: threadId });
			}

			await ctx.db.patch('threadRecords', grandchild, { parentThreadId: children[0] });

			for (const id of [other, grandchild]) {
				await ctx.db.patch('threadRecords', id, { title: 'Fix the radio' });
			}

			const run = await ctx.db
				.query('runs')
				.withIndex('by_threadId', (q) => q.eq('threadId', grandchild))
				.unique();

			const tokens = {
				inputTokens: 1,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				outputTokens: 1,
				reasoningTokens: 0
			};

			for (let index = 0; index < 300; index++) {
				await ctx.db.insert('modelCallUsage', {
					userId: subject,
					runId: run!._id,
					eventId: `call-${index}`,
					provider: 'spikonado',
					model: 'gpt-5.6-sol',
					serviceTier: 'standard',
					cacheWriteTtl: null,
					longContext: false,
					...tokens
				});
			}

			await ctx.db.patch('files', await insertDraftFile(ctx, subject), { threadId: grandchild });
			await ctx.db.insert('storageUsage', { userId: subject, bytes: 5 });
		});

		await asUser.mutation(api.threads.remove, { threadId });

		expect(await asUser.query(api.threads.getByThreadId, { threadId })).toBeNull();
		await expect(createQueuedRun(t, asUser, children[1]!, 'orphan', 'orphan')).rejects.toThrow(
			'Thread not found.'
		);

		const search = await asUser.query(api.inbox.list, {
			state: 'unsettled',
			repositoryKeys: ['alpha'],
			query: 'radio',
			paginationOpts: { numItems: 10, cursor: null }
		});

		expect(search.page.map((thread) => thread._id)).toEqual([other]);

		await finishDueScheduledFunctions(t);

		const remaining = await t.run(async (ctx) => ({
			threads: (await ctx.db.query('threadRecords').collect()).map((thread) => thread._id),
			runs: (await ctx.db.query('runs').collect()).map((run) => run.threadId),
			runStates: (await ctx.db.query('runExecutionStates').collect()).length,
			modelCalls: (await ctx.db.query('modelCallUsage').collect()).length,
			files: (await ctx.db.query('files').collect()).length,
			storageUsage: (await ctx.db.query('storageUsage').unique())?.bytes
		}));

		expect(remaining).toEqual({
			threads: [other],
			runs: [other],
			runStates: 1,
			modelCalls: 0,
			files: 0,
			storageUsage: 0
		});
	});

	it('refuses to delete a thread with active work', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		await createQueuedRun(t, asUser, threadId, 'active', 'active');

		await expect(asUser.mutation(api.threads.remove, { threadId })).rejects.toThrow(
			'Stop the thread before deleting it.'
		);
		expect(await asUser.query(api.threads.getByThreadId, { threadId })).not.toBeNull();
	});
});
