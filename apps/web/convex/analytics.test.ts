import { afterEach, describe, expect, it, vi } from 'vitest';
import { internal } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import { initConvexTest, insertQueuedRun, seedOwnedThread } from './test.setup';

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe('run_completed', () => {
	it('summarizes usage, tools, handoffs and question waits', async () => {
		vi.stubEnv('POSTHOG_PROJECT_TOKEN', 'phc_test');
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);

		const { runId } = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'analytics-run',
			executionSecret: 'analytics-secret',
			prompt: 'Read a skill'
		});

		await t.run(async (ctx) => {
			const usage = {
				provider: 'spikonado' as const,
				model: 'gpt-5.6-sol',
				serviceTier: 'standard' as const,
				cacheWriteTtl: null,
				longContext: false,
				inputTokens: 100,
				cacheReadTokens: 40,
				cacheWriteTokens: 0,
				outputTokens: 10,
				reasoningTokens: 5
			};

			for (const eventId of ['turn:1', 'handoff:claim:1:0', 'handoff:claim:1:1']) {
				await ctx.db.insert('modelCallUsage', { userId: 'user_alice', runId, eventId, ...usage });
			}

			const job = (
				sequence: number,
				kind: 'read_skill' | 'spawn_subagent',
				payload: Doc<'executorJobs'>['payload']
			) =>
				ctx.db.insert('executorJobs', {
					threadId,
					runId,
					kind,
					payload,
					status: 'completed',
					enqueuedAt: 0,
					sequence
				});

			await job(1, 'read_skill', { name: 'cleanup' });
			await job(2, 'read_skill', { name: 'cleanup' });
			const questionJobId = await job(3, 'spawn_subagent', { prompt: 'Help' });

			const questionId = await ctx.db.insert('agentQuestions', {
				threadId,
				runId,
				jobId: questionJobId,
				question: 'Continue?',
				options: [],
				status: 'answered',
				sequence: 1
			});

			const question = await ctx.db.get('agentQuestions', questionId);
			await ctx.db.patch('agentQuestions', questionId, {
				answeredAt: question!._creationTime + 2_000
			});
		});

		await t.action(internal.analytics.captureRunCompleted, { runId });

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://eu.i.posthog.com/i/v0/e/');
		expect(JSON.parse(String(init?.body))).toMatchObject({
			api_key: 'phc_test',
			event: 'run_completed',
			distinct_id: 'user_alice',
			properties: {
				run_id: runId,
				site: 'sprocket_app',
				model_calls: 3,
				context_handoffs: 1,
				input_tokens: 300,
				output_tokens: 30,
				question_wait_ms: 2_000,
				tool_calls: { read_skill: 2, spawn_subagent: 1 },
				subagents_spawned: 1,
				skills_read: ['cleanup']
			}
		});
	});
});
