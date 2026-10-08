import { describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import { createQueuedRun, initConvexTest, seedOwnedThread, seedThreadRecord } from './test.setup';

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

	it.each(['unsettled', 'settled'] as const)(
		'restores %s history and artifacts when a removed project key is re-added',
		async (state) => {
			const t = initConvexTest();
			const { asUser, subject, threadId, repositoryKey } = await seedOwnedThread(t);
			const second = await seedThreadRecord(t, subject, 'beta');
			const prompt = 'Create project notes';
			const executionSecret = 'inbox-project-removal-secret';

			const { runId } = await createQueuedRun(
				t,
				asUser,
				threadId,
				'inbox-project-removal',
				executionSecret,
				prompt
			);

			const auth = { runId, executionSecret, claimId: 'inbox-project-removal-claim' };
			await asUser.mutation(api.agentRuntime.start, auth);

			const { artifactId } = await asUser.mutation(api.artifacts.addArtifact, {
				...auth,
				registrationId: 'inbox-project-notes',
				scope: 'project',
				title: 'Project notes',
				contentType: 'markdown',
				content: '# Preserved project notes'
			});

			await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
				runId,
				executionSecret,
				expectedStatus: 'running',
				expectedClaimId: auth.claimId,
				text: 'Created project notes',
				status: 'completed'
			});

			if (state === 'settled') {
				await asUser.mutation(api.threads.settle, { threadId });
				await asUser.mutation(api.threads.settle, { threadId: second });
			}

			const listInbox = (repositoryKeys: string[]) =>
				asUser.query(api.inbox.list, {
					state,
					repositoryKeys,
					paginationOpts: { numItems: 10, cursor: null }
				});

			const readHistory = async () => ({
				thread: await asUser.query(api.threads.getByThreadId, { threadId }),
				run: await t.run((ctx) => ctx.db.get('runs', runId)),
				transcript: await asUser.query(api.transcript.getParts, { threadId, numbers: [0] }),
				artifacts: await asUser.query(api.artifacts.listArtifacts, { repositoryKey }),
				artifact: await asUser.query(api.artifacts.getArtifact, { repositoryKey, artifactId })
			});

			const attached = await listInbox([repositoryKey, 'beta']);
			expect(attached.page.map((thread) => thread._id).sort()).toEqual([threadId, second].sort());
			const history = await readHistory();
			expect(history.run).toMatchObject({ threadId, status: 'completed' });
			expect(history.transcript.parts).toMatchObject([
				{ number: 0, kind: 'prompt', prompt: { text: prompt } }
			]);
			expect(history.artifacts.page.map((artifact) => artifact._id)).toEqual([artifactId]);
			expect(history.artifact).toMatchObject({
				content: '# Preserved project notes',
				revision: 1
			});

			const removed = await listInbox(['beta']);
			expect(removed.page.map((thread) => thread._id)).toEqual([second]);
			expect(await readHistory()).toEqual(history);

			const restored = await listInbox([repositoryKey, 'beta']);
			expect(restored.page).toEqual(attached.page);
			expect(await readHistory()).toEqual(history);
		}
	);

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

	it.each(['queued', 'running'] as const)('refuses to settle a %s thread', async (status) => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'inbox-settle-secret';
		const { runId } = await createQueuedRun(t, asUser, threadId, 'inbox-active', executionSecret);

		if (status === 'running') {
			await asUser.mutation(api.agentRuntime.start, {
				runId,
				executionSecret,
				claimId: 'inbox-claim'
			});
		}

		await expect(asUser.mutation(api.threads.settle, { threadId })).rejects.toThrow('active work');
	});

	it('settles question-waiting work only after Stop', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);

		const runId = await t.run(async (ctx) => {
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
				timeoutAt: Date.now() + 60_000,
				sequence: 1
			});

			return run._id;
		});

		await expect(asUser.mutation(api.threads.settle, { threadId })).rejects.toThrow('active work');
		await asUser.mutation(api.agentRuntime.requestCancellation, { runId });
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
