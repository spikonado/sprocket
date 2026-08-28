import { describe, expect, it } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';
import { executionSecretHash } from '@convex/lib/auth';

describe('convex component registration', () => {
	it('registers the five reliability components', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const created = await createQueuedRun(t, asUser, threadId, 'component-reg', 'secret', 'Hello');
		const run = await t.run(async (ctx) => ctx.db.get('runs', created.runId));
		expect(run?.lifecycleWorkflowId).toEqual(expect.any(String));
	});
});

describe('transcript and usage migrations', () => {
	it('migrates a poison run without blocking later runs', async () => {
		const t = initConvexTest();
		const { threadId, subject, repositoryKey } = await seedOwnedThread(t);
		const poisonThread = await t.withIdentity({ subject }).mutation(api.threads.create, {
			submissionId: `poison-thread-${Math.random()}`,
			repositoryKey,
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			serviceTier: 'standard'
		});
		const goodRunId = await t.run(async (ctx) => {
			const poisonRunId = await ctx.db.insert('runs', {
				threadId: poisonThread.threadId,
				userId: subject,
				submissionId: 'poison-run',
				status: 'completed',
				executionSecretHash: await executionSecretHash('poison-secret'),
				completionAttemptSeq: 0,
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				serviceTier: 'standard',
				startedAt: 1,
				completedAt: 2
			});
			const poisonPromptId = await ctx.db.insert('threadMessages', {
				threadId: poisonThread.threadId,
				runId: poisonRunId,
				userId: subject,
				type: 'prompt',
				text: 'Poison prompt',
				parts: []
			});
			await ctx.db.patch('runs', poisonRunId, { promptMessageId: poisonPromptId });
			await ctx.db.insert('threadTranscriptStates', {
				threadId: poisonThread.threadId,
				userId: subject,
				totalParts: 0
			});
			await ctx.db.insert('threadTranscriptParts', {
				threadId: poisonThread.threadId,
				userId: subject,
				number: 0,
				sourceKey: 'collision',
				kind: 'prompt',
				runId: poisonRunId,
				prompt: { text: 'occupied', imageUploads: [] }
			});
			return await ctx.db.insert('runs', {
				threadId,
				userId: subject,
				submissionId: 'good-run',
				status: 'completed',
				executionSecretHash: await executionSecretHash('good-secret'),
				completionAttemptSeq: 0,
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				serviceTier: 'standard',
				startedAt: 3,
				completedAt: 4
			});
		});
		await t.run(async (ctx) => {
			const promptId = await ctx.db.insert('threadMessages', {
				threadId,
				runId: goodRunId,
				userId: subject,
				type: 'prompt',
				text: 'Recovered prompt',
				parts: []
			});
			await ctx.db.patch('runs', goodRunId, { promptMessageId: promptId });
		});
		await t.mutation(internal.migrations.migrateLegacyRunTranscriptParts, {});
		await t.finishAllScheduledFunctions(() => {});
		const state = await t.run(async (ctx) =>
			ctx.db
				.query('threadTranscriptStates')
				.withIndex('by_threadId', (query) => query.eq('threadId', threadId))
				.unique()
		);
		expect((state?.totalParts ?? 0) >= 1).toBe(true);
	});

	it('skips orphan tool results on failed legacy runs', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const created = await createQueuedRun(
			t,
			asUser,
			threadId,
			'failed-legacy',
			'failed-legacy-secret',
			'Do it'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId: created.runId,
			claimId: 'claim-fail',
			executionSecret: 'failed-legacy-secret'
		});
		await t.run(async (ctx) => {
			const responseId = await ctx.db.insert('threadMessages', {
				threadId,
				runId: created.runId,
				userId: 'user_alice',
				type: 'response',
				text: '',
				parts: [{ type: 'tool-result', callId: 'c1', name: 'web_search', output: 'ok' }]
			});
			await ctx.db.patch('runs', created.runId, {
				status: 'failed',
				responseMessageId: responseId,
				completedAt: Date.now()
			});
			const state = await ctx.db
				.query('threadTranscriptStates')
				.withIndex('by_threadId', (query) => query.eq('threadId', threadId))
				.unique();
			if (state) {
				await ctx.db.patch('threadTranscriptStates', state._id, {
					migratedAt: undefined,
					totalParts: 0
				});
			}
			const parts = await ctx.db
				.query('threadTranscriptParts')
				.withIndex('by_threadId_and_number', (query) => query.eq('threadId', threadId))
				.collect();
			for (const part of parts) {
				await ctx.db.delete('threadTranscriptParts', part._id);
			}
		});
		await t.run(async (ctx) => {
			const { migrateLegacyThreadTranscript } = await import('@convex/lib/transcriptMigrate');
			await migrateLegacyThreadTranscript(ctx, { threadId, userId: 'user_alice' });
		});
		const parts = await asUser.query(api.transcript.getParts, {
			threadId,
			numbers: [0, 1, 2]
		});
		expect(parts.parts.some((part: { kind: string }) => part.kind === 'tool')).toBe(false);
	});
});
