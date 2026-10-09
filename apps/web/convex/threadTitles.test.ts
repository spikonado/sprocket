import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { appendTranscriptPart } from '@convex/lib/transcriptParts';
import { verifyGatewayToken } from '@convex/lib/gatewayToken';
import { z } from 'zod';
import { initConvexTest, type ConvexTestInstance } from './test.setup';

const secret = 'test-title-secret';

function createRun(t: ConvexTestInstance, submissionId: string, threadId?: Id<'threadRecords'>) {
	return t.mutation(internal.agentRuntime.insertGatewayRun, {
		userId: 'alice',
		submissionId,
		...(threadId ? { threadId } : { repositoryKey: 'alpha' }),
		prompt: submissionId === 'first' ? 'Build a robot' : 'Add obstacle avoidance',
		imageUploadIds: [],
		selectedModel: 'gpt-6.1-sol',
		completionProvider: 'chatgpt',
		reasoningEffort: 'high',
		fastMode: true,
		executionSecret: `secret-${submissionId}`,
		protocolVersion: 1
	});
}

async function finishTitle(t: ConvexTestInstance) {
	await vi.advanceTimersByTimeAsync(0);
	await t.finishInProgressScheduledFunctions();
}

async function finishRun(t: ConvexTestInstance, runId: Id<'runs'>) {
	await t.run(async (ctx) => {
		await ctx.db.patch('runs', runId, { status: 'completed' });

		const state = await ctx.db
			.query('runExecutionStates')
			.withIndex('by_runId', (query) => query.eq('runId', runId))
			.unique();

		await ctx.db.patch('runExecutionStates', state!._id, { terminalJobsReconciled: true });
	});
}

function titleResponse(title: string) {
	return Response.json({
		status: 'completed',
		output: [{ type: 'message', content: [{ type: 'output_text', text: title }] }]
	});
}

describe('automatic thread titles', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubEnv('MODEL_GATEWAY_URL', 'https://gateway.example');
		vi.stubEnv('MODEL_GATEWAY_TOKEN_SECRET', secret);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('names and renames through each prompt using only conversation text across pages', async () => {
		const t = initConvexTest();

		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(titleResponse('Robot project'))
			.mockResolvedValueOnce(titleResponse('Robot obstacle avoidance'));

		vi.stubGlobal('fetch', fetchMock);
		const first = await createRun(t, 'first');
		await finishTitle(t);
		expect(await t.run((ctx) => ctx.db.get('threadRecords', first.threadId))).toMatchObject({
			title: 'Robot project'
		});
		await t.run(async (ctx) => {
			await appendTranscriptPart(ctx, {
				threadId: first.threadId,
				userId: 'alice',
				runId: first.runId,
				sourceKey: 'previous-completion',
				kind: 'completion',
				completion: {
					items: [
						{ type: 'text', id: 'text', text: 'The robot uses two motors.' },
						{ type: 'reasoning', id: 'reasoning', text: 'Private reasoning' },
						{ type: 'tool-call', callId: 'call', name: 'exec_cmd', input: { cmd: 'secret' } }
					]
				},
				work: { ranges: [] }
			});

			for (let index = 0; index < 105; index++) {
				await appendTranscriptPart(ctx, {
					threadId: first.threadId,
					userId: 'alice',
					runId: first.runId,
					sourceKey: `tool-${index}`,
					kind: 'tool',
					tool: { callId: 'call', name: 'exec_cmd', output: 'Tool output', status: 'completed' },
					work: { ranges: [] }
				});
			}
		});
		await finishRun(t, first.runId);
		const second = await createRun(t, 'second', first.threadId);
		await t.run((ctx) =>
			appendTranscriptPart(ctx, {
				threadId: first.threadId,
				userId: 'alice',
				runId: second.runId,
				sourceKey: 'after-second-prompt',
				kind: 'completion',
				completion: { items: [{ type: 'text', id: 'later', text: 'Later response' }] },
				work: { ranges: [] }
			})
		);
		await finishTitle(t);
		expect(await t.run((ctx) => ctx.db.get('threadRecords', first.threadId))).toMatchObject({
			title: 'Robot obstacle avoidance',
			selectedModel: 'gpt-6.1-sol',
			completionProvider: 'chatgpt',
			reasoningEffort: 'high'
		});
		const [url, options] = fetchMock.mock.calls[1];
		expect(url).toBe('https://gateway.example/api/v1/responses');

		const body = z
			.object({
				model: z.string(),
				reasoning: z.object({ effort: z.string() }),
				input: z.array(z.object({ role: z.string(), content: z.string() }))
			})
			.parse(JSON.parse(String(options?.body)));

		expect(body).toEqual({
			model: 'gpt-6-luna',
			reasoning: { effort: 'low' },
			input: [
				{ role: 'user', content: 'Build a robot' },
				{ role: 'assistant', content: 'The robot uses two motors.' },
				{ role: 'user', content: 'Add obstacle avoidance' }
			]
		});
		const token = new Headers(options?.headers).get('Authorization')!.slice('Bearer '.length);
		expect(await verifyGatewayToken(secret, token)).toMatchObject({ userId: 'alice' });
	});

	it('keeps manual names when disabled and resumes naming after re-enabling', async () => {
		const t = initConvexTest();
		const alice = t.withIdentity({ subject: 'alice' });
		await alice.mutation(api.uiPreferences.setAutomaticThreadTitles, { enabled: false });
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(titleResponse('Robot navigation'));
		vi.stubGlobal('fetch', fetchMock);
		const first = await createRun(t, 'first');
		await alice.mutation(api.threads.rename, { threadId: first.threadId, title: 'My robot' });
		await finishTitle(t);
		expect(
			await alice.query(api.threads.getByThreadId, { threadId: first.threadId })
		).toMatchObject({
			title: 'My robot'
		});
		await finishRun(t, first.runId);
		await alice.mutation(api.uiPreferences.setAutomaticThreadTitles, { enabled: true });
		await createRun(t, 'second', first.threadId);
		await finishTitle(t);
		expect(
			await alice.query(api.threads.getByThreadId, { threadId: first.threadId })
		).toMatchObject({
			title: 'Robot navigation'
		});
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it('keeps the newest title when a previous prompt finishes naming late', async () => {
		const t = initConvexTest();
		const first = await createRun(t, 'first');
		await finishRun(t, first.runId);
		const second = await createRun(t, 'second', first.threadId);
		const request = { expectedTitle: 'Build a robot' };
		await t.mutation(internal.threadTitles.apply, {
			...request,
			runId: first.runId,
			title: 'Old title'
		});
		await t.mutation(internal.threadTitles.apply, {
			...request,
			runId: second.runId,
			title: 'Obstacle avoidance'
		});
		expect(await t.run((ctx) => ctx.db.get('threadRecords', first.threadId))).toMatchObject({
			title: 'Obstacle avoidance'
		});
		await finishTitle(t);
	});

	it.each(['rename', 'disable'] as const)('preserves an in-flight %s choice', async (choice) => {
		const t = initConvexTest();
		const alice = t.withIdentity({ subject: 'alice' });
		const first = await createRun(t, 'first');
		vi.stubGlobal(
			'fetch',
			vi.fn<typeof fetch>().mockImplementation(async () => {
				if (choice === 'rename') {
					await alice.mutation(api.threads.rename, { threadId: first.threadId, title: 'My title' });
				} else {
					await alice.mutation(api.uiPreferences.setAutomaticThreadTitles, { enabled: false });
				}

				return titleResponse('Generated title');
			})
		);
		await finishTitle(t);
		expect(
			await alice.query(api.threads.getByThreadId, { threadId: first.threadId })
		).toMatchObject({
			title: choice === 'rename' ? 'My title' : 'Build a robot'
		});
	});

	it('retains the current title and active run when the title provider fails', async () => {
		const t = initConvexTest();
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.stubGlobal(
			'fetch',
			vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 }))
		);
		const first = await createRun(t, 'first');
		await finishTitle(t);
		expect(await t.run((ctx) => ctx.db.get('threadRecords', first.threadId))).toMatchObject({
			title: 'Build a robot',
			status: 'queued'
		});
		expect(errorLog).toHaveBeenCalledOnce();
	});
});
