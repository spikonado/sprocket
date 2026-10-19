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
		executionSecret: `secret-${submissionId}`
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

	it('names only the first prompt and regenerates from conversation text across pages', async () => {
		const t = initConvexTest();
		const alice = t.withIdentity({ subject: 'alice' });

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
			title: 'Robot project'
		});
		expect(fetchMock).toHaveBeenCalledOnce();
		await alice.action(api.threadTitles.regenerate, { threadId: first.threadId });
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
				input: z.string()
			})
			.parse(JSON.parse(String(options?.body)));

		expect(body).toEqual({
			model: 'gpt-6-luna',
			reasoning: { effort: 'high' },
			input:
				'User:\nBuild a robot\n\nAssistant:\nThe robot uses two motors.\n\nUser:\nAdd obstacle avoidance\n\nAssistant:\nLater response'
		});
		const token = new Headers(options?.headers).get('Authorization')!.slice('Bearer '.length);
		expect(await verifyGatewayToken(secret, token)).toMatchObject({ userId: 'alice' });
	});

	it('keeps manual names after re-enabling and allows regeneration while disabled', async () => {
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
			title: 'My robot'
		});
		expect(fetchMock).not.toHaveBeenCalled();
		await alice.mutation(api.uiPreferences.setAutomaticThreadTitles, { enabled: false });
		await alice.action(api.threadTitles.regenerate, { threadId: first.threadId });
		await finishTitle(t);
		expect(
			await alice.query(api.threads.getByThreadId, { threadId: first.threadId })
		).toMatchObject({
			title: 'Robot navigation'
		});
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it('applies first-prompt naming even when another prompt arrives before it finishes', async () => {
		const t = initConvexTest();
		const first = await createRun(t, 'first');
		await finishRun(t, first.runId);
		const second = await createRun(t, 'second', first.threadId);
		const request = { expectedTitle: 'Build a robot' };
		await t.mutation(internal.threadTitles.apply, {
			...request,
			runId: first.runId,
			title: 'Robot project'
		});
		await t.mutation(internal.threadTitles.apply, {
			...request,
			runId: second.runId,
			title: 'Ignored follow-up title'
		});
		expect(await t.run((ctx) => ctx.db.get('threadRecords', first.threadId))).toMatchObject({
			title: 'Robot project'
		});
		await finishTitle(t);
	});

	it('only lets the newest regeneration request apply its title', async () => {
		const t = initConvexTest();
		const alice = t.withIdentity({ subject: 'alice' });
		const first = await createRun(t, 'first');
		vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(titleResponse('Robot project')));
		await finishTitle(t);
		await alice.mutation(internal.threadTitles.requestRegeneration, { threadId: first.threadId });
		const previous = await t.run((ctx) => ctx.db.get('threadRecords', first.threadId));
		await alice.mutation(internal.threadTitles.requestRegeneration, { threadId: first.threadId });
		const newest = await t.run((ctx) => ctx.db.get('threadRecords', first.threadId));

		const part = await t.run((ctx) =>
			ctx.db
				.query('threadTranscriptParts')
				.withIndex('by_threadId_and_number', (query) => query.eq('threadId', first.threadId))
				.first()
		);

		await t.mutation(internal.threadTitles.apply, {
			runId: first.runId,
			expectedTitle: 'Robot project',
			expectedRenameKey: previous!.titleRenameKey,
			throughNumber: part!.number,
			title: 'Older title'
		});
		expect(
			await alice.query(api.threads.getByThreadId, { threadId: first.threadId })
		).toMatchObject({ title: 'Robot project' });
		await t.mutation(internal.threadTitles.apply, {
			runId: first.runId,
			expectedTitle: 'Robot project',
			expectedRenameKey: newest!.titleRenameKey,
			throughNumber: part!.number,
			title: 'Newest title'
		});
		expect(
			await alice.query(api.threads.getByThreadId, { threadId: first.threadId })
		).toMatchObject({
			title: 'Newest title'
		});
		await finishTitle(t);
	});

	it('requires ownership to regenerate a title', async () => {
		const t = initConvexTest();
		vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(titleResponse('Robot project')));
		const first = await createRun(t, 'first');
		await expect(
			t.withIdentity({ subject: 'bob' }).action(api.threadTitles.regenerate, {
				threadId: first.threadId
			})
		).rejects.toThrow();
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

	it('preserves a manual name restored while generation is pending', async () => {
		const t = initConvexTest();
		const alice = t.withIdentity({ subject: 'alice' });
		const first = await createRun(t, 'first');
		await alice.mutation(api.threads.rename, { threadId: first.threadId, title: 'My title' });
		await finishRun(t, first.runId);
		await createRun(t, 'second', first.threadId);
		vi.stubGlobal(
			'fetch',
			vi.fn<typeof fetch>().mockImplementation(async () => {
				await alice.mutation(api.threads.rename, {
					threadId: first.threadId,
					title: 'Other title'
				});
				await alice.mutation(api.threads.rename, { threadId: first.threadId, title: 'My title' });

				return titleResponse('Generated title');
			})
		);
		await alice.action(api.threadTitles.regenerate, { threadId: first.threadId });
		await finishTitle(t);
		expect(
			await alice.query(api.threads.getByThreadId, { threadId: first.threadId })
		).toMatchObject({ title: 'My title' });
	});

	it.each(['gateway error', 'timeout', 'empty title'])(
		'reports manual generation failure: %s',
		async (failure) => {
			const t = initConvexTest();
			const alice = t.withIdentity({ subject: 'alice' });
			await alice.mutation(api.uiPreferences.setAutomaticThreadTitles, { enabled: false });
			const first = await createRun(t, 'first');
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const fetchMock = vi.fn<typeof fetch>();

			if (failure === 'timeout') {
				fetchMock.mockRejectedValue(new DOMException('Timed out', 'TimeoutError'));
			} else {
				fetchMock.mockResolvedValue(
					failure === 'empty title' ? titleResponse('') : new Response('', { status: 503 })
				);
			}

			vi.stubGlobal('fetch', fetchMock);
			await expect(
				alice.action(api.threadTitles.regenerate, { threadId: first.threadId })
			).rejects.toThrow('Could not regenerate thread title. Try again.');
			expect(
				await alice.query(api.threads.getByThreadId, { threadId: first.threadId })
			).toMatchObject({ title: 'Build a robot' });
			await finishTitle(t);
		}
	);
});
