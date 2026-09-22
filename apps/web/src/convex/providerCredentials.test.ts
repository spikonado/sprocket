import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { patchRunExecution } from '@convex/lib/runExecution';
import { api, internal } from './_generated/api';
import { initConvexTest, insertQueuedRun, seedOwnedThread } from './test.setup';

describe('provider credentials', () => {
	beforeEach(() => {
		process.env.WORKOS_API_KEY = 'sk_workos_test';
		process.env.WORKOS_CLIENT_ID = 'client_test';
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		delete process.env.WORKOS_API_KEY;
		delete process.env.WORKOS_CLIENT_ID;
	});

	it('validates and stores an OpenAI key without returning it', async () => {
		const t = initConvexTest();
		const asUser = t.withIdentity({ subject: 'user_alice' });
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			requests.push({ url, init });
			if (url === 'https://api.openai.com/v1/models') return new Response('{}');
			if (url.includes('/vault/v1/kv/name/')) return new Response('', { status: 404 });
			return Response.json({ id: 'secret_1' });
		});

		expect(
			await asUser.action(api.providerCredentials.saveOpenAiKey, { apiKey: ' sk-user ' })
		).toBe(null);
		expect(requests.map(({ url }) => url)).toEqual([
			'https://api.openai.com/v1/models',
			expect.stringContaining('/vault/v1/kv/name/sprocket-openai-'),
			'https://api.workos.com/vault/v1/kv'
		]);
		expect(JSON.parse(String(requests[2].init?.body))).toMatchObject({
			key_context: { application_id: 'client_test' },
			value: 'sk-user'
		});
	});

	it('only issues a configured key to an active direct OpenAI run', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'executor-secret';
		const claimId = 'claim-openai';
		const created = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'provider-run',
			executionSecret,
			prompt: 'Use my key',
			completionProvider: 'openai'
		});
		await asUser.mutation(api.agentRuntime.start, {
			runId: created.runId,
			claimId,
			executionSecret
		});
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('user_alice'));
		const name = `sprocket-openai-${Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, '0')
		).join('')}`;
		vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
		await expect(
			t.action(api.providerCredentials.issueOpenAiCredential, {
				runId: created.runId,
				claimId,
				executionSecret
			})
		).rejects.toThrow('OpenAI is no longer configured.');

		vi.stubGlobal('fetch', async () =>
			Response.json({
				id: 'secret_1',
				name,
				value: 'sk-user'
			})
		);

		await expect(
			t.action(api.providerCredentials.issueOpenAiCredential, {
				runId: created.runId,
				claimId,
				executionSecret
			})
		).resolves.toEqual({ apiKey: 'sk-user' });

		await expect(
			t.query(internal.providerCredentials.authorizeOpenAiCredential, {
				runId: created.runId,
				claimId,
				executionSecret: 'wrong-secret'
			})
		).rejects.toThrow('Run not found.');

		await t.run(async (ctx) => {
			await ctx.db.patch('runs', created.runId, { completionProvider: 'spikonado' });
		});
		await expect(
			t.query(internal.providerCredentials.authorizeOpenAiCredential, {
				runId: created.runId,
				claimId,
				executionSecret
			})
		).rejects.toThrow('Run is not configured to use OpenAI directly.');

		await t.run(async (ctx) => {
			await ctx.db.patch('runs', created.runId, { completionProvider: 'openai' });
			await patchRunExecution(ctx, created.runId, { claimExpiresAt: Date.now() - 1 });
		});
		await expect(
			t.query(internal.providerCredentials.authorizeOpenAiCredential, {
				runId: created.runId,
				claimId,
				executionSecret
			})
		).rejects.toThrow('Run is no longer active.');
	}, 30_000);
});
