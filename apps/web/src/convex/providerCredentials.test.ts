import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function vaultEntry(name: string, value: string, id = 'secret_1'): VaultEntry {
	return { id, name, value, metadata: { version_id: `version_${id}` } };
}

function jwt(claims: {
	exp: number;
	chatgpt_account_id?: string;
	'https://api.openai.com/auth'?: {
		chatgpt_account_id: string;
		chatgpt_compute_residency?: string;
	};
}): string {
	const header = Buffer.from('{"alg":"none"}').toString('base64url');
	const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
	return `${header}.${payload}.signature`;
}

async function providerCredentialName(prefix: string, userId = 'user_alice'): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userId));
	return `${prefix}${Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('')}`;
}

function stubProviderFetch(
	entries: Map<string, VaultEntry>,
	providerResponse: (url: string, init?: RequestInit) => Response | Promise<Response>
) {
	let nextId = entries.size + 1;
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (!url.startsWith('https://api.workos.com/')) return await providerResponse(url, init);

		const parsedUrl = new URL(url);
		const nameMarker = '/vault/v1/kv/name/';
		if (parsedUrl.pathname.startsWith(nameMarker)) {
			const entry = entries.get(decodeURIComponent(parsedUrl.pathname.slice(nameMarker.length)));
			return entry ? Response.json(entry) : new Response(null, { status: 404 });
		}
		if (init?.method === 'POST') {
			const body = z
				.object({ name: z.string(), value: z.string() })
				.parse(JSON.parse(String(init.body)));
			const entry = vaultEntry(body.name, body.value, `secret_${nextId++}`);
			entries.set(entry.name, entry);
			return Response.json(entry);
		}
		const id = decodeURIComponent(parsedUrl.pathname.split('/').at(-1) ?? '');
		const entry = [...entries.values()].find((candidate) => candidate.id === id);
		if (!entry) return new Response(null, { status: 404 });
		if (init?.method === 'DELETE') {
			if (parsedUrl.searchParams.get('version_check') !== entry.metadata.version_id) {
				return new Response(null, { status: 409 });
			}
			entries.delete(entry.name);
			return new Response(null, { status: 204 });
		}
		if (init?.method === 'PUT') {
			const body = z
				.object({ value: z.string(), version_check: z.string() })
				.parse(JSON.parse(String(init.body)));
			if (body.version_check !== entry.metadata.version_id) {
				return new Response(null, { status: 409 });
			}
			entry.value = body.value;
			entry.metadata.version_id = `${entry.metadata.version_id}-next`;
			return Response.json(entry);
		}
		return new Response(null, { status: 405 });
	});
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

async function startedChatGptRun() {
	const t = initConvexTest();
	const { asUser, threadId } = await seedOwnedThread(t);
	const executionSecret = 'executor-secret';
	const claimId = 'claim-chatgpt';
	const created = await insertQueuedRun(t, asUser, {
		threadId,
		submissionId: `chatgpt-run-${crypto.randomUUID()}`,
		executionSecret,
		prompt: 'Use my subscription',
		completionProvider: 'chatgpt'
	});
	await asUser.mutation(api.agentRuntime.start, {
		runId: created.runId,
		claimId,
		executionSecret
	});
	return { t, asUser, runId: created.runId, claimId, executionSecret };
}

describe('provider credentials', () => {
	beforeEach(() => {
		process.env.WORKOS_API_KEY = 'sk_workos_test';
		process.env.WORKOS_CLIENT_ID = 'client_test';
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
		delete process.env.WORKOS_API_KEY;
		delete process.env.WORKOS_CLIENT_ID;
	});

	it('starts ChatGPT device login and reports pending authorization', async () => {
		const t = initConvexTest();
		const asUser = t.withIdentity({ subject: 'user_alice' });
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			requests.push({ url, init });
			if (url.endsWith('/api/accounts/deviceauth/usercode')) {
				return Response.json({ device_auth_id: 'device-1', user_code: 'ABCD-EFGH', interval: '3' });
			}
			return new Response(null, { status: 403 });
		});

		await expect(
			asUser.action(api.providerCredentials.beginChatGptDeviceLogin, {})
		).resolves.toMatchObject({
			deviceAuthId: 'device-1',
			userCode: 'ABCD-EFGH',
			verificationUrl: 'https://auth.openai.com/codex/device',
			intervalMs: 3_000
		});
		await expect(
			asUser.action(api.providerCredentials.pollChatGptDeviceLogin, {
				deviceAuthId: 'device-1',
				userCode: 'ABCD-EFGH'
			})
		).resolves.toEqual({ status: 'pending' });
		expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
			client_id: 'app_EMoamEEZ73f0CkXaXp7hrann'
		});
	});

	it('exchanges a device authorization and stores account metadata in Vault', async () => {
		const t = initConvexTest();
		const asUser = t.withIdentity({ subject: 'user_alice' });
		const entries = new Map<string, VaultEntry>();
		const exp = Math.floor(Date.now() / 1_000) + 3_600;
		const accessToken = jwt({
			exp,
			'https://api.openai.com/auth': {
				chatgpt_account_id: 'account-1',
				chatgpt_compute_residency: 'us'
			}
		});
		const fetchMock = stubProviderFetch(entries, (url, init) => {
			if (url.endsWith('/api/accounts/deviceauth/usercode')) {
				return Response.json({ device_auth_id: 'device-1', user_code: 'ABCD-EFGH' });
			}
			if (url.endsWith('/api/accounts/deviceauth/token')) {
				return Response.json({
					authorization_code: 'authorization-1',
					code_verifier: 'verifier-1'
				});
			}
			if (url.endsWith('/oauth/token')) {
				expect(String(init?.body)).toContain('grant_type=authorization_code');
				return Response.json({ access_token: accessToken, refresh_token: 'refresh-1' });
			}
			if (url.includes('/backend-api/codex/models')) {
				expect(new Headers(init?.headers).get('x-openai-internal-codex-residency')).toBe('us');
				return Response.json({ models: [{ slug: 'gpt-5.4' }, { slug: 'gpt-5.4' }] });
			}
			throw new Error(`Unexpected provider request: ${url}`);
		});
		await asUser.action(api.providerCredentials.beginChatGptDeviceLogin, {});

		await expect(
			asUser.action(api.providerCredentials.pollChatGptDeviceLogin, {
				deviceAuthId: 'device-1',
				userCode: 'ABCD-EFGH'
			})
		).resolves.toEqual({ status: 'connected', modelIds: ['gpt-5.4'] });

		const name = await providerCredentialName('sprocket-chatgpt-');
		const stored = JSON.parse(entries.get(name)?.value ?? '{}');
		expect(stored).toMatchObject({
			version: 1,
			accessToken,
			refreshToken: 'refresh-1',
			accountId: 'account-1',
			residency: 'us',
			expiresAt: exp * 1_000
		});
		await expect(
			t.query(internal.providerCredentials.getChatGptCredentialState, {
				userId: 'user_alice'
			})
		).resolves.toMatchObject({ expiresAt: exp * 1_000, modelIds: ['gpt-5.4'] });
		expect(fetchMock).toHaveBeenCalled();
		await asUser.action(api.providerCredentials.cancelChatGptDeviceLogin, {
			deviceAuthId: 'device-1',
			userCode: 'ABCD-EFGH'
		});
		expect(entries.has(name)).toBe(false);
		await expect(asUser.action(api.providerCredentials.getMyConfiguration, {})).resolves.toEqual({
			openai: false,
			chatgpt: false,
			chatgptModelIds: null
		});
	});

	it('retries model discovery after the ChatGPT account is connected', async () => {
		const t = initConvexTest();
		const asUser = t.withIdentity({ subject: 'user_alice' });
		const name = await providerCredentialName('sprocket-chatgpt-');
		const entries = new Map<string, VaultEntry>([
			[
				name,
				vaultEntry(
					name,
					JSON.stringify({
						version: 1,
						accessToken: 'access-current',
						refreshToken: 'refresh-current',
						accountId: 'account-1',
						expiresAt: Date.now() + 60 * 60 * 1_000
					})
				)
			]
		]);
		let delayModels = false;
		let finishModels: ((response: Response) => void) | undefined;
		stubProviderFetch(entries, (url) => {
			if (url.includes('/backend-api/codex/models')) {
				if (delayModels) {
					return new Promise<Response>((resolve) => {
						finishModels = resolve;
					});
				}
				return Response.json({ models: [{ slug: 'gpt-5.4' }] });
			}
			throw new Error(`Unexpected provider request: ${url}`);
		});
		await expect(asUser.action(api.providerCredentials.refreshChatGptModels, {})).resolves.toEqual([
			'gpt-5.4'
		]);
		await expect(asUser.action(api.providerCredentials.getMyConfiguration, {})).resolves.toEqual({
			openai: false,
			chatgpt: true,
			chatgptModelIds: ['gpt-5.4']
		});

		delayModels = true;
		const retrying = asUser.action(api.providerCredentials.refreshChatGptModels, {});
		await vi.waitFor(() => expect(finishModels).toBeDefined());
		const disconnecting = asUser.action(api.providerCredentials.removeChatGptCredential, {});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(entries.has(name)).toBe(true);
		finishModels?.(Response.json({ models: [{ slug: 'gpt-5.4' }] }));
		await expect(retrying).resolves.toEqual(['gpt-5.4']);
		await expect(disconnecting).resolves.toBe(null);
		expect(entries.has(name)).toBe(false);
	});

	it('rejects polling another user’s device authorization before contacting ChatGPT', async () => {
		const t = initConvexTest();
		const owner = t.withIdentity({ subject: 'user_alice' });
		const other = t.withIdentity({ subject: 'user_bob' });
		const fetchMock = vi.fn(async () =>
			Response.json({ device_auth_id: 'device-1', user_code: 'ABCD-EFGH' })
		);
		vi.stubGlobal('fetch', fetchMock);
		await owner.action(api.providerCredentials.beginChatGptDeviceLogin, {});
		await expect(
			other.action(api.providerCredentials.pollChatGptDeviceLogin, {
				deviceAuthId: 'device-1',
				userCode: 'ABCD-EFGH'
			})
		).rejects.toThrow('ChatGPT sign-in expired or was cancelled.');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('cancels a pending device login before an in-flight poll stores credentials', async () => {
		const t = initConvexTest();
		const owner = t.withIdentity({ subject: 'user_alice' });
		let approve: ((response: Response) => void) | undefined;
		const entries = new Map<string, VaultEntry>();
		stubProviderFetch(entries, (url) => {
			if (url.endsWith('/api/accounts/deviceauth/usercode')) {
				return Response.json({ device_auth_id: 'device-1', user_code: 'ABCD-EFGH' });
			}
			if (url.endsWith('/api/accounts/deviceauth/token')) {
				return new Promise<Response>((resolve) => {
					approve = resolve;
				});
			}
			throw new Error(`Unexpected provider request: ${url}`);
		});
		await owner.action(api.providerCredentials.beginChatGptDeviceLogin, {});
		const polling = owner.action(api.providerCredentials.pollChatGptDeviceLogin, {
			deviceAuthId: 'device-1',
			userCode: 'ABCD-EFGH'
		});
		await vi.waitFor(() => expect(approve).toBeDefined());
		await owner.action(api.providerCredentials.cancelChatGptDeviceLogin, {
			deviceAuthId: 'device-1',
			userCode: 'ABCD-EFGH'
		});
		approve?.(
			Response.json({ authorization_code: 'authorization-1', code_verifier: 'verifier-1' })
		);
		await expect(polling).rejects.toThrow('ChatGPT sign-in expired or was cancelled.');
		expect(entries.size).toBe(0);
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
			t.query(internal.providerCredentials.authorizeOpenAiCredential, {
				runId: created.runId,
				claimId,
				executionSecret
			})
		).rejects.toThrow('Run is no longer active.');
		await t.run(async (ctx) => {
			await ctx.db.patch('runs', created.runId, { cancellationRequestedAt: undefined });
		});

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

	it('issues ChatGPT credentials only to an active ChatGPT run', async () => {
		const { t, runId, claimId, executionSecret } = await startedChatGptRun();
		const name = await providerCredentialName('sprocket-chatgpt-');
		const credential = {
			version: 1,
			accessToken: 'access-current',
			refreshToken: 'refresh-current',
			accountId: 'account-1',
			residency: 'eu',
			expiresAt: Date.now() + 60 * 60 * 1_000
		};
		const entries = new Map<string, VaultEntry>([
			[name, vaultEntry(name, JSON.stringify(credential))]
		]);
		stubProviderFetch(entries, (url) => {
			throw new Error(`Unexpected provider request: ${url}`);
		});

		await expect(
			t.action(api.providerCredentials.issueChatGptCredential, {
				runId,
				claimId,
				executionSecret
			})
		).resolves.toEqual({
			accessToken: 'access-current',
			accountId: 'account-1',
			residency: 'eu'
		});

		await t.run(async (ctx) => {
			await ctx.db.patch('runs', runId, { completionProvider: 'openai' });
		});
		await expect(
			t.action(api.providerCredentials.issueChatGptCredential, {
				runId,
				claimId,
				executionSecret
			})
		).rejects.toThrow('Run is not configured to use ChatGPT.');
	});

	it('serializes refresh-token rotation across concurrent issuers', async () => {
		const { t, runId, claimId, executionSecret } = await startedChatGptRun();
		const name = await providerCredentialName('sprocket-chatgpt-');
		const entries = new Map<string, VaultEntry>([
			[
				name,
				vaultEntry(
					name,
					JSON.stringify({
						version: 1,
						accessToken: 'access-expired',
						refreshToken: 'refresh-once',
						accountId: 'account-1',
						expiresAt: Date.now() - 1
					})
				)
			]
		]);
		let refreshes = 0;
		const rotatedAccessToken = jwt({
			exp: Math.floor(Date.now() / 1_000) + 3_600,
			chatgpt_account_id: 'account-1'
		});
		const fetchMock = stubProviderFetch(entries, async (url, init) => {
			if (!url.endsWith('/oauth/token')) throw new Error(`Unexpected provider request: ${url}`);
			expect(new URLSearchParams(String(init?.body)).get('refresh_token')).toBe('refresh-once');
			refreshes += 1;
			await new Promise((resolve) => setTimeout(resolve, 100));
			return Response.json({
				access_token: rotatedAccessToken,
				refresh_token: 'refresh-rotated'
			});
		});

		const args = { runId, claimId, executionSecret };
		const [first, second] = await Promise.all([
			t.action(api.providerCredentials.issueChatGptCredential, args),
			t.action(api.providerCredentials.issueChatGptCredential, args)
		]);
		expect(first.accessToken).toBe(rotatedAccessToken);
		expect(second.accessToken).toBe(rotatedAccessToken);
		expect(refreshes).toBe(1);
		expect(JSON.parse(entries.get(name)?.value ?? '{}')).toMatchObject({
			accessToken: rotatedAccessToken,
			refreshToken: 'refresh-rotated'
		});
		const update = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
		expect(JSON.parse(String(update?.[1]?.body))).toMatchObject({
			version_check: 'version_secret_1'
		});
	}, 30_000);

	it('releases the refresh lease after ChatGPT rejects a refresh token', async () => {
		const { t, runId, claimId, executionSecret } = await startedChatGptRun();
		const name = await providerCredentialName('sprocket-chatgpt-');
		const entries = new Map<string, VaultEntry>([
			[
				name,
				vaultEntry(
					name,
					JSON.stringify({
						version: 1,
						accessToken: 'access-expired',
						refreshToken: 'refresh-invalid',
						accountId: 'account-1',
						expiresAt: Date.now() - 1
					})
				)
			]
		]);
		stubProviderFetch(entries, (url) => {
			if (url.endsWith('/oauth/token')) return new Response(null, { status: 401 });
			throw new Error(`Unexpected provider request: ${url}`);
		});

		await expect(
			t.action(api.providerCredentials.issueChatGptCredential, {
				runId,
				claimId,
				executionSecret
			})
		).rejects.toThrow('ChatGPT sign-in expired.');
		await expect(
			t.mutation(internal.providerCredentials.acquireChatGptCredentialLease, {
				userId: 'user_alice',
				leaseId: 'next-lease'
			})
		).resolves.toBe(true);
	});

	it('rejects credential issuance after ChatGPT is disconnected', async () => {
		const { t, runId, claimId, executionSecret } = await startedChatGptRun();
		stubProviderFetch(new Map(), (url) => {
			throw new Error(`Unexpected provider request: ${url}`);
		});
		await expect(
			t.action(api.providerCredentials.issueChatGptCredential, {
				runId,
				claimId,
				executionSecret
			})
		).rejects.toThrow('ChatGPT is no longer connected.');
	});

	it('deletes the ChatGPT credential and its metadata', async () => {
		const t = initConvexTest();
		const asUser = t.withIdentity({ subject: 'user_alice' });
		const name = await providerCredentialName('sprocket-chatgpt-');
		const entries = new Map<string, VaultEntry>([
			[
				name,
				vaultEntry(
					name,
					JSON.stringify({
						version: 1,
						accessToken: 'access-current',
						refreshToken: 'refresh-current',
						accountId: 'account-1',
						expiresAt: Date.now() + 60 * 60 * 1_000
					})
				)
			]
		]);
		const fetchMock = stubProviderFetch(entries, (url) => {
			throw new Error(`Unexpected provider request: ${url}`);
		});
		await t.mutation(internal.providerCredentials.acquireChatGptCredentialLease, {
			userId: 'user_alice',
			leaseId: 'setup'
		});
		await t.run(async (ctx) => {
			const state = await ctx.db
				.query('providerCredentialStates')
				.withIndex('by_userId_and_provider', (query) =>
					query.eq('userId', 'user_alice').eq('provider', 'chatgpt')
				)
				.unique();
			if (!state) throw new Error('Missing credential state');
			await ctx.db.patch(state._id, {
				expiresAt: Date.now() + 60 * 60 * 1_000,
				modelIds: ['gpt-5.4'],
				refreshLeaseId: undefined,
				refreshLeaseExpiresAt: undefined
			});
		});

		await expect(asUser.action(api.providerCredentials.removeChatGptCredential, {})).resolves.toBe(
			null
		);
		expect(entries.has(name)).toBe(false);
		const deletion = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE');
		expect(new URL(String(deletion?.[0])).searchParams.get('version_check')).toBe(
			'version_secret_1'
		);
		await expect(
			t.query(internal.providerCredentials.getChatGptCredentialState, {
				userId: 'user_alice'
			})
		).resolves.toBe(null);
	});
});
