import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import agentErrorMessages from '@convex/lib/agentErrorCodes.json';
import { z } from 'zod';
import { patchRunExecution } from '@convex/lib/runExecution';
import { api, internal } from './_generated/api';
import { initConvexTest, insertQueuedRun, seedOwnedThread } from './test.setup';

type VaultEntry = {
	id: string;
	name: string;
	value: string;
	metadata: { version_id: string };
};

function stubVaultFetch(entries: Map<string, VaultEntry>) {
	vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));

		if (url.origin !== 'https://api.workos.com') return new Response('{}');

		const nameMarker = '/vault/v1/kv/name/';

		if (url.pathname.startsWith(nameMarker)) {
			const entry = entries.get(decodeURIComponent(url.pathname.slice(nameMarker.length)));

			return entry ? Response.json(entry) : new Response(null, { status: 404 });
		}

		if (init?.method === 'POST' && url.pathname === '/vault/v1/kv') {
			const body = z
				.object({ name: z.string(), value: z.string() })
				.parse(JSON.parse(String(init.body)));

			const id = `secret_${entries.size + 1}`;
			const entry = { id, ...body, metadata: { version_id: `version_${id}` } };
			entries.set(entry.name, entry);

			return Response.json(entry);
		}

		if (init?.method === 'DELETE') {
			const id = decodeURIComponent(url.pathname.slice('/vault/v1/kv/'.length));
			const entry = [...entries.values()].find((candidate) => candidate.id === id);

			if (entry) entries.delete(entry.name);

			return new Response(null, { status: entry ? 200 : 404 });
		}

		return new Response(null, { status: 405 });
	});
}

describe('provider credentials', () => {
	beforeEach(() => {
		vi.stubEnv('WORKOS_API_KEY', 'sk_workos_test');
		vi.stubEnv('WORKOS_CLIENT_ID', 'client_test');
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it.each([
		{
			provider: 'openai',
			url: 'https://api.openai.com/v1/models',
			headers: { authorization: 'Bearer sk-user' }
		},
		{
			provider: 'anthropic',
			url: 'https://api.anthropic.com/v1/models',
			headers: { 'x-api-key': 'sk-user', 'anthropic-version': '2023-06-01' }
		},
		{
			provider: 'vercel',
			url: 'https://ai-gateway.vercel.sh/v1/credits',
			headers: { authorization: 'Bearer sk-user' }
		},
		{
			provider: 'openrouter',
			url: 'https://openrouter.ai/api/v1/key',
			headers: { authorization: 'Bearer sk-user' }
		},
		{
			provider: 'opencode',
			url: 'https://opencode.ai/inference/v1/models',
			headers: { authorization: 'Bearer sk-user' }
		},
		{
			provider: 'opencode-go',
			url: 'https://opencode.ai/inference/go/v1/models',
			headers: { authorization: 'Bearer sk-user' }
		},
		{
			provider: 'morph',
			url: 'https://api.morphllm.com/api/v1/dedicated/endpoints',
			headers: { authorization: 'Bearer sk-user' }
		}
	] as const)('validates and stores a $provider key without returning it', async (expected) => {
		const t = initConvexTest();
		const asUser = t.withIdentity({ subject: 'user_alice' });
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			requests.push({ url, init });

			if (url === expected.url) return new Response('{}');

			if (url.includes('/vault/v1/kv/name/')) return new Response('', { status: 404 });

			return Response.json({ id: 'secret_1' });
		});

		expect(
			await asUser.action(api.providerCredentials.saveApiKey, {
				provider: expected.provider,
				apiKey: ' sk-user '
			})
		).toBe(null);
		expect(requests.map(({ url }) => url)).toEqual([
			expected.url,
			expect.stringContaining(`/vault/v1/kv/name/sprocket-${expected.provider}-`),
			'https://api.workos.com/vault/v1/kv'
		]);
		expect(requests[0].init?.headers).toEqual(expected.headers);
		expect(JSON.parse(String(requests[2].init?.body))).toMatchObject({
			key_context: { application_id: 'client_test' },
			value: 'sk-user'
		});
	});

	it('reports a key the provider rejects', async () => {
		const asUser = initConvexTest().withIdentity({ subject: 'user_alice' });
		vi.stubGlobal('fetch', async () => new Response('', { status: 401 }));

		await expect(
			asUser.action(api.providerCredentials.saveApiKey, { provider: 'vercel', apiKey: 'bad' })
		).rejects.toThrow('Vercel AI Gateway rejected this API key.');
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
			t.action(api.providerCredentials.issueApiKey, {
				provider: 'openai',
				runId: created.runId,
				claimId,
				executionSecret
			})
		).rejects.toThrow('OpenAI is no longer configured.');

		vi.stubGlobal('fetch', async () =>
			Response.json({
				id: 'secret_1',
				name,
				value: 'sk-user',
				metadata: { version_id: 'version_secret_1' }
			})
		);

		await expect(
			t.action(api.providerCredentials.issueOpenAiCredential, {
				runId: created.runId,
				claimId,
				executionSecret
			})
		).resolves.toEqual({ apiKey: 'sk-user' });

		await t.run(async (ctx) => {
			await ctx.db.patch('runs', created.runId, { cancellationRequestedAt: Date.now() });
		});
		await expect(
			t.query(internal.providerCredentials.authorizeRunCredential, {
				runId: created.runId,
				claimId,
				executionSecret,
				provider: 'openai'
			})
		).rejects.toMatchObject({ data: agentErrorMessages.RUN_NO_LONGER_ACTIVE });
		await t.run(async (ctx) => {
			await ctx.db.patch('runs', created.runId, { cancellationRequestedAt: undefined });
		});

		await expect(
			t.query(internal.providerCredentials.authorizeRunCredential, {
				runId: created.runId,
				claimId,
				executionSecret: 'wrong-secret',
				provider: 'openai'
			})
		).rejects.toThrow('Run not found.');

		await t.run(async (ctx) => {
			await ctx.db.patch('runs', created.runId, { completionProvider: 'spikonado' });
		});
		await expect(
			t.query(internal.providerCredentials.authorizeRunCredential, {
				runId: created.runId,
				claimId,
				executionSecret,
				provider: 'openai'
			})
		).rejects.toThrow('Run is not configured to use openai credentials.');

		await t.run(async (ctx) => {
			await ctx.db.patch('runs', created.runId, { completionProvider: 'openai' });
			await patchRunExecution(ctx, created.runId, { claimExpiresAt: Date.now() - 1 });
		});
		await expect(
			t.query(internal.providerCredentials.authorizeRunCredential, {
				runId: created.runId,
				claimId,
				executionSecret,
				provider: 'openai'
			})
		).rejects.toMatchObject({ data: agentErrorMessages.RUN_NO_LONGER_ACTIVE });
	}, 30_000);

	it('stores a Claude token without calling Anthropic and issues it to Claude runs', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'executor-secret';
		const claimId = 'claim-claude';
		stubVaultFetch(new Map());

		await expect(
			asUser.action(api.providerCredentials.saveClaudeToken, { token: 'sk-ant-api03-key' })
		).rejects.toThrow("That isn't a valid Claude token");
		await asUser.action(api.providerCredentials.saveClaudeToken, {
			token: ' sk-ant-oat01-token_A-1 '
		});
		await expect(asUser.action(api.providerCredentials.getMyConfiguration, {})).resolves.toEqual({
			openai: false,
			claude: true,
			anthropic: false,
			vercel: false,
			openrouter: false,
			opencode: false,
			opencodeGo: false,
			morph: false
		});

		const created = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'claude-run',
			executionSecret,
			prompt: 'Use my subscription',
			completionProvider: 'claude'
		});

		await asUser.mutation(api.agentRuntime.start, {
			runId: created.runId,
			claimId,
			executionSecret
		});
		const run = { runId: created.runId, claimId, executionSecret };

		await expect(t.action(api.providerCredentials.issueClaudeCredential, run)).resolves.toEqual({
			token: 'sk-ant-oat01-token_A-1'
		});
		await expect(
			t.action(api.providerCredentials.issueApiKey, { ...run, provider: 'anthropic' })
		).rejects.toThrow('Run is not configured to use anthropic credentials.');

		vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
		await expect(t.action(api.providerCredentials.issueClaudeCredential, run)).rejects.toThrow(
			'Claude is no longer connected.'
		);
	}, 30_000);

	it('reports saved API keys and keeps the provider order in sync', async () => {
		const t = initConvexTest();
		const asUser = t.withIdentity({ subject: 'user_alice' });
		vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
		await expect(asUser.action(api.providerCredentials.getMyConfiguration, {})).resolves.toEqual({
			openai: false,
			claude: false,
			anthropic: false,
			vercel: false,
			openrouter: false,
			opencode: false,
			opencodeGo: false,
			morph: false
		});

		stubVaultFetch(new Map());
		await asUser.action(api.providerCredentials.saveOpenAiKey, { apiKey: 'sk-user' });
		await asUser.action(api.providerCredentials.saveApiKey, {
			provider: 'openrouter',
			apiKey: 'sk-or-user'
		});
		await expect(asUser.action(api.providerCredentials.getMyConfiguration, {})).resolves.toEqual({
			openai: true,
			claude: false,
			anthropic: false,
			vercel: false,
			openrouter: true,
			opencode: false,
			opencodeGo: false,
			morph: false
		});
		expect(await asUser.query(api.uiPreferences.getMyProviderOrder, {})).toEqual([
			{ provider: 'spikonado', enabled: true },
			{ provider: 'openai', enabled: true },
			{ provider: 'openrouter', enabled: true }
		]);

		await asUser.action(api.providerCredentials.removeApiKey, { provider: 'openai' });
		expect(await asUser.query(api.uiPreferences.getMyProviderOrder, {})).toEqual([
			{ provider: 'spikonado', enabled: true },
			{ provider: 'openrouter', enabled: true }
		]);
	});
});
