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
	await t.run(async (ctx) => {
		await ctx.db.insert('providerCredentialStates', {
			userId: 'user_alice',
			connectionId: 'connection-1'
		});
	});
	return { t, asUser, runId: created.runId, claimId, executionSecret };
}

async function chatGptVault(expiresAt = Date.now() + 3_600_000) {
	const name = await providerCredentialName('sprocket-chatgpt-');
	const credential = {
		version: 1,
		connectionId: 'connection-1',
		accessToken: 'access-current',
		refreshToken: 'refresh-current',
		accountId: 'account-1',
		expiresAt
	};
	const entries = new Map([[name, vaultEntry(name, JSON.stringify(credential))]]);
	return { name, credential, entries };
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

	it('exchanges a loopback browser code with PKCE and saves the credential in Vault', async () => {
		const t = initConvexTest();
		const owner = t.withIdentity({ subject: 'user_alice' });
		const other = t.withIdentity({ subject: 'user_bob' });
		const state = 'a'.repeat(64);
		const entries = new Map<string, VaultEntry>();
		const exp = Math.floor(Date.now() / 1_000) + 3_600;
		let verifier = '';
		stubProviderFetch(entries, (url, init) => {
			if (url.endsWith('/oauth/token')) {
				const body = new URLSearchParams(String(init?.body));
				expect(body.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
				expect(body.get('code')).toBe('browser-code');
				expect(body.get('code_verifier')).toBe(verifier);
				return Response.json({
					access_token: jwt({ exp, chatgpt_account_id: 'account-1' }),
					refresh_token: 'browser-refresh'
				});
			}
			if (url.includes('/backend-api/codex/models')) {
				return Response.json({ models: [{ slug: 'gpt-5.4' }] });
			}
			throw new Error(`Unexpected provider request: ${url}`);
		});
		const authorizeUrl = new URL(
			await owner.action(api.providerCredentials.beginChatGptBrowserLogin, { state })
		);
		verifier = await t.query(internal.providerCredentials.authorizeChatGptBrowserLogin, {
			userId: 'user_alice',
			hash: await providerCredentialName('', state)
		});
		const digest = new Uint8Array(
			await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
		);
		const expectedChallenge = Buffer.from(digest).toString('base64url');
		expect(authorizeUrl.searchParams.get('code_challenge')).toBe(expectedChallenge);
		expect(authorizeUrl.searchParams.get('state')).toBe(state);
		expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(
			'http://localhost:1455/auth/callback'
		);
		await expect(
			other.action(api.providerCredentials.completeChatGptBrowserLogin, {
				state,
				code: 'browser-code'
			})
		).rejects.toThrow('ChatGPT sign-in expired or was cancelled.');
		await expect(
			owner.action(api.providerCredentials.completeChatGptBrowserLogin, {
				state,
				code: 'browser-code'
			})
		).resolves.toEqual(['gpt-5.4']);
		expect(
			JSON.parse(entries.get(await providerCredentialName('sprocket-chatgpt-'))!.value)
		).toMatchObject({
			refreshToken: 'browser-refresh',
			accountId: 'account-1'
		});
		await expect(
			owner.action(api.providerCredentials.completeChatGptBrowserLogin, {
				state,
				code: 'browser-code'
			})
		).rejects.toThrow('ChatGPT sign-in expired or was cancelled.');
	});

	it('cancels a browser sign-in without affecting a later attempt', async () => {
		const t = initConvexTest();
		const owner = t.withIdentity({ subject: 'user_alice' });
		const first = 'b'.repeat(64);
		const second = 'c'.repeat(64);
		await owner.action(api.providerCredentials.beginChatGptBrowserLogin, { state: first });
		await owner.action(api.providerCredentials.beginChatGptBrowserLogin, { state: second });
		await owner.action(api.providerCredentials.cancelChatGptBrowserLogin, { state: first });
		await expect(
			t.query(internal.providerCredentials.authorizeChatGptBrowserLogin, {
				userId: 'user_alice',
				hash: await providerCredentialName('', second)
			})
		).resolves.toBeTruthy();
		await owner.action(api.providerCredentials.cancelChatGptBrowserLogin, { state: second });
		await expect(
			t.query(internal.providerCredentials.authorizeChatGptBrowserLogin, {
				userId: 'user_alice',
				hash: await providerCredentialName('', second)
			})
		).rejects.toThrow('ChatGPT sign-in expired or was cancelled.');
	});

	it('removes a browser credential when cancellation races its Vault write', async () => {
		const t = initConvexTest();
		const owner = t.withIdentity({ subject: 'user_alice' });
		const state = 'd'.repeat(64);
		const entries = new Map<string, VaultEntry>();
		const exp = Math.floor(Date.now() / 1_000) + 3_600;
		const fetchVault = stubProviderFetch(entries, (url) => {
			if (url.endsWith('/oauth/token')) {
				return Response.json({
					access_token: jwt({ exp, chatgpt_account_id: 'account-1' }),
					refresh_token: 'browser-refresh'
				});
			}
			if (url.includes('/backend-api/codex/models')) {
				return Response.json({ models: [{ slug: 'gpt-5.4' }] });
			}
			throw new Error(`Unexpected provider request: ${url}`);
		});
		let enterVaultWrite: () => void = () => {};
		const vaultWriteStarted = new Promise<void>((resolve) => {
			enterVaultWrite = resolve;
		});
		let finishVaultWrite: () => void = () => {};
		const vaultWriteFinished = new Promise<void>((resolve) => {
			finishVaultWrite = resolve;
		});
		vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
			if (String(input) === 'https://api.workos.com/vault/v1/kv' && init?.method === 'POST') {
				enterVaultWrite();
				await vaultWriteFinished;
			}
			return fetchVault(input, init);
		});

		await owner.action(api.providerCredentials.beginChatGptBrowserLogin, { state });
		const completing = owner.action(api.providerCredentials.completeChatGptBrowserLogin, {
			state,
			code: 'browser-code'
		});
		await vaultWriteStarted;
		const cancelling = owner.action(api.providerCredentials.cancelChatGptBrowserLogin, { state });
		finishVaultWrite();
		await expect(completing).resolves.toEqual(['gpt-5.4']);
		await expect(cancelling).resolves.toBeNull();
		expect(entries.has(await providerCredentialName('sprocket-chatgpt-'))).toBe(false);
		await expect(owner.action(api.providerCredentials.getMyConfiguration, {})).resolves.toEqual({
			openai: false,
			chatgpt: false,
			chatgptModelIds: null
		});
	});

	it.each([
		['browser', 'device'],
		['device', 'browser'],
		['browser', 'browser'],
		['device', 'device']
	] as const)(
		'keeps the %s login replacement via %s when cancelling the older login',
		async (firstFlow, replacementFlow) => {
			const { t, asUser: owner, runId, executionSecret } = await startedChatGptRun();
			const connection = () =>
				t.query(api.providerCredentials.chatGptConnection, { runId, executionSecret });
			const entries = new Map<string, VaultEntry>();
			let accountId = 'first-account';
			let deviceAttempt = 0;
			stubProviderFetch(entries, (url) => {
				if (url.endsWith('/api/accounts/deviceauth/usercode')) {
					return Response.json({
						device_auth_id: `device-${++deviceAttempt}`,
						user_code: 'ABCD-EFGH'
					});
				}
				if (url.endsWith('/api/accounts/deviceauth/token')) {
					return Response.json({ authorization_code: 'device-code', code_verifier: 'verifier' });
				}
				if (url.endsWith('/oauth/token')) {
					return Response.json({
						access_token: jwt({
							exp: Math.floor(Date.now() / 1_000) + 3_600,
							chatgpt_account_id: accountId
						}),
						refresh_token: `refresh-${accountId}`
					});
				}
				if (url.includes('/backend-api/codex/models')) {
					return Response.json({ models: [{ slug: 'gpt-5.4' }] });
				}
				throw new Error(`Unexpected provider request: ${url}`);
			});
			let browserAttempt = 0;
			const flows = {
				browser: async () => {
					const state = String(++browserAttempt).repeat(64);
					await owner.action(api.providerCredentials.beginChatGptBrowserLogin, { state });
					await owner.action(api.providerCredentials.completeChatGptBrowserLogin, {
						state,
						code: 'browser-code'
					});
					return () => owner.action(api.providerCredentials.cancelChatGptBrowserLogin, { state });
				},
				device: async () => {
					const { deviceAuthId, userCode } = await owner.action(
						api.providerCredentials.beginChatGptDeviceLogin,
						{}
					);
					const device = { deviceAuthId, userCode };
					await owner.action(api.providerCredentials.pollChatGptDeviceLogin, device);
					return () => owner.action(api.providerCredentials.cancelChatGptDeviceLogin, device);
				}
			};
			const cancelFirst = await flows[firstFlow]();
			const firstConnection = await connection();
			expect(firstConnection).toEqual(expect.any(String));
			accountId = 'replacement-account';
			const cancelReplacement = await flows[replacementFlow]();
			const replacementConnection = await connection();
			expect(replacementConnection).toEqual(expect.any(String));
			expect(replacementConnection).not.toBe(firstConnection);
			await cancelFirst();
			expect(await connection()).toBe(replacementConnection);
			const name = await providerCredentialName('sprocket-chatgpt-');
			expect(JSON.parse(entries.get(name)?.value ?? '{}')).toMatchObject({
				connectionId: replacementConnection,
				accountId: 'replacement-account',
				refreshToken: 'refresh-replacement-account'
			});
			await expect(owner.action(api.providerCredentials.getMyConfiguration, {})).resolves.toEqual({
				openai: false,
				chatgpt: true,
				chatgptModelIds: ['gpt-5.4']
			});
			await cancelReplacement();
			expect(await connection()).toBeNull();
		}
	);

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
				return Response.json({
					access_token: accessToken,
					refresh_token: 'refresh-1',
					id_token: jwt({ exp, chatgpt_account_id: 'account-1' })
				});
			}
			if (url.includes('/backend-api/codex/models')) {
				const clientVersion = new URL(url).searchParams.get('client_version');
				expect(clientVersion).toBe('0.156.1');
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
		expect(stored).not.toHaveProperty('idToken');
		await expect(
			t.query(internal.providerCredentials.getChatGptConfiguration, {
				userId: 'user_alice'
			})
		).resolves.toEqual({ connectionId: stored.connectionId, modelIds: ['gpt-5.4'] });
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
		await t.run(async (ctx) => {
			await ctx.db.insert('providerCredentialStates', {
				userId: 'user_alice',
				connectionId: 'connection-1'
			});
		});
		const name = await providerCredentialName('sprocket-chatgpt-');
		const entries = new Map<string, VaultEntry>([
			[
				name,
				vaultEntry(
					name,
					JSON.stringify({
						version: 1,
						connectionId: 'connection-1',
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
			if (url.endsWith('/oauth/revoke')) return new Response(null, { status: 200 });
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

	it('reuses an unexpired ChatGPT token and exposes its expiry to an active run', async () => {
		const { t, runId, claimId, executionSecret } = await startedChatGptRun();
		const name = await providerCredentialName('sprocket-chatgpt-');
		const credential = {
			version: 1,
			connectionId: 'connection-1',
			accessToken: 'access-current',
			refreshToken: 'refresh-current',
			accountId: 'account-1',
			residency: 'eu',
			expiresAt: Date.now() + 60_000
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
			connectionId: 'connection-1',
			accountId: 'account-1',
			residency: 'eu',
			expiresAt: credential.expiresAt
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

	it.each([-1, 10_000])(
		'serializes rotation with %i ms of token lifetime remaining',
		async (lifetime) => {
			const { t, runId, claimId, executionSecret } = await startedChatGptRun();
			const name = await providerCredentialName('sprocket-chatgpt-');
			const entries = new Map<string, VaultEntry>([
				[
					name,
					vaultEntry(
						name,
						JSON.stringify({
							version: 1,
							connectionId: 'connection-1',
							accessToken: 'access-expired',
							refreshToken: 'refresh-once',
							accountId: 'account-1',
							expiresAt: Date.now() + lifetime
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
			expect(first.expiresAt).toBeGreaterThan(Date.now());
			expect(second.expiresAt).toBe(first.expiresAt);
			expect(first.connectionId).toBe('connection-1');
			expect(second.connectionId).toBe(first.connectionId);
			expect(refreshes).toBe(1);
			expect(JSON.parse(entries.get(name)?.value ?? '{}')).toMatchObject({
				accessToken: rotatedAccessToken,
				refreshToken: 'refresh-rotated'
			});
			const update = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
			expect(JSON.parse(String(update?.[1]?.body))).toMatchObject({
				version_check: 'version_secret_1'
			});
		},
		30_000
	);

	it('keeps the current connection during pending logins and clears it on disconnect', async () => {
		const { t, asUser, runId, executionSecret } = await startedChatGptRun();
		const args = { runId, executionSecret };
		const connection = () => t.query(api.providerCredentials.chatGptConnection, args);
		stubProviderFetch(new Map(), (url) => {
			if (url.endsWith('/api/accounts/deviceauth/usercode')) {
				return Response.json({ device_auth_id: 'device-pending', user_code: 'ABCD-EFGH' });
			}
			throw new Error(`Unexpected provider request: ${url}`);
		});
		expect(await connection()).toBe('connection-1');
		await expect(
			t.query(api.providerCredentials.chatGptConnection, {
				...args,
				executionSecret: 'wrong-secret'
			})
		).rejects.toThrow('Run not found.');
		const state = 'f'.repeat(64);
		await asUser.action(api.providerCredentials.beginChatGptBrowserLogin, { state });
		expect(await connection()).toBe('connection-1');
		await asUser.action(api.providerCredentials.cancelChatGptBrowserLogin, { state });
		expect(await connection()).toBe('connection-1');
		await asUser.action(api.providerCredentials.beginChatGptDeviceLogin, {});
		expect(await connection()).toBe('connection-1');
		await asUser.action(api.providerCredentials.cancelChatGptDeviceLogin, {
			deviceAuthId: 'device-pending',
			userCode: 'ABCD-EFGH'
		});
		expect(await connection()).toBe('connection-1');
		await asUser.action(api.providerCredentials.removeChatGptCredential, {});
		expect(await connection()).toBeNull();
	});

	it.each(['metadata', 'vault'] as const)(
		'rejects issuance racing replacement in %s',
		async (changed) => {
			const { t, runId, claimId, executionSecret } = await startedChatGptRun();
			const name = await providerCredentialName('sprocket-chatgpt-');
			const entries = new Map([
				[
					name,
					vaultEntry(
						name,
						JSON.stringify({
							version: 1,
							connectionId: changed === 'vault' ? 'replacement' : 'connection-1',
							accessToken: 'access-token',
							refreshToken: 'refresh-token',
							accountId: 'account-1',
							expiresAt: Date.now() + 3_600_000
						})
					)
				]
			]);
			const fetchVault = stubProviderFetch(entries, (url) => {
				throw new Error(`Unexpected provider request: ${url}`);
			});
			vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
				const response = await fetchVault(input, init);
				if (changed === 'metadata') {
					await t.run(async (ctx) => {
						const state = await ctx.db
							.query('providerCredentialStates')
							.withIndex('by_userId', (q) => q.eq('userId', 'user_alice'))
							.unique();
						if (!state) throw new Error('Missing credential state');
						await ctx.db.patch(state._id, { connectionId: 'replacement' });
					});
				}
				return response;
			});
			await expect(
				t.action(api.providerCredentials.issueChatGptCredential, {
					runId,
					claimId,
					executionSecret
				})
			).rejects.toThrow('ChatGPT connection changed during credential issuance.');
		}
	);

	it('recovers when model recording fails after a refreshed credential reaches Vault', async () => {
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
						connectionId: 'connection-1',
						accessToken: 'access-expired',
						refreshToken: 'refresh-once',
						accountId: 'account-1',
						expiresAt: Date.now() - 1
					})
				)
			]
		]);
		const rotatedAccessToken = jwt({
			exp: Math.floor(Date.now() / 1_000) + 3_600,
			chatgpt_account_id: 'account-1'
		});
		let refreshes = 0;
		const fetchMock = stubProviderFetch(entries, (url) => {
			if (url.endsWith('/oauth/token')) {
				refreshes += 1;
				return Response.json({
					access_token: rotatedAccessToken,
					refresh_token: 'refresh-rotated'
				});
			}
			if (url.includes('/backend-api/codex/models')) {
				return Response.json({ models: [{ slug: 'gpt-5.4' }] });
			}
			throw new Error(`Unexpected provider request: ${url}`);
		});
		let finishVaultWrite: (() => void) | undefined;
		vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
			const response = await fetchMock(input, init);
			if (init?.method === 'PUT') {
				await new Promise<void>((resolve) => {
					finishVaultWrite = resolve;
				});
			}
			return response;
		});

		const refreshing = asUser.action(api.providerCredentials.refreshChatGptModels, {});
		await vi.waitFor(() => expect(finishVaultWrite).toBeDefined());
		expect(JSON.parse(entries.get(name)?.value ?? '{}')).toMatchObject({
			accessToken: rotatedAccessToken,
			refreshToken: 'refresh-rotated'
		});
		await t.run(async (ctx) => {
			const state = await ctx.db
				.query('providerCredentialStates')
				.withIndex('by_userId', (query) => query.eq('userId', 'user_alice'))
				.unique();
			if (!state) throw new Error('Missing credential state');
			await ctx.db.patch(state._id, {
				lease: { id: 'replacement-lease', expiresAt: Date.now() - 1 }
			});
		});
		finishVaultWrite?.();
		await expect(refreshing).rejects.toThrow('ChatGPT credential update lost its lease.');
		await expect(asUser.action(api.providerCredentials.refreshChatGptModels, {})).resolves.toEqual([
			'gpt-5.4'
		]);
		expect(refreshes).toBe(1);
	}, 30_000);

	it.each([
		'invalid_grant',
		'invalid_refresh_token',
		'token_expired',
		'refresh_token_expired',
		'refresh_token_invalidated',
		'refresh_token_reused'
	])('disconnects an unusable session after refresh returns %s', async (code) => {
		const { t, runId, claimId, executionSecret } = await startedChatGptRun();
		const { name, entries } = await chatGptVault(Date.now() - 1);
		stubProviderFetch(entries, (url) => {
			if (url.endsWith('/oauth/token')) return Response.json({ error: code }, { status: 400 });
			throw new Error(`Unexpected provider request: ${url}`);
		});

		await expect(
			t.action(api.providerCredentials.issueChatGptCredential, {
				runId,
				claimId,
				executionSecret
			})
		).rejects.toThrow('ChatGPT sign-in expired.');
		expect(entries.has(name)).toBe(false);
		await expect(
			t.query(api.providerCredentials.chatGptConnection, { runId, executionSecret })
		).resolves.toBeNull();
		await expect(
			t
				.withIdentity({ subject: 'user_alice' })
				.action(api.providerCredentials.getMyConfiguration, {})
		).resolves.toEqual({
			openai: false,
			chatgpt: false,
			chatgptModelIds: null
		});
		await expect(
			t.mutation(internal.providerCredentials.acquireChatGptCredentialLease, {
				userId: 'user_alice',
				leaseId: 'next-lease'
			})
		).resolves.toBe(true);
	});

	it.each([
		{
			status: 401,
			error: { error: { code: 'invalid_client' } },
			message: 'not configured correctly'
		},
		{ status: 403, error: { detail: 'Policy restriction' }, message: 'workspace policy' },
		{ status: 400, error: { error: 'invalid_request' }, message: 'auth configuration' },
		{ status: 401, error: null, message: 'Try again shortly' },
		{ status: 503, error: { error: 'server_error' }, message: 'Try again shortly' }
	])(
		'preserves the session and permits recovery after refresh HTTP $status with $error',
		async ({ status, error, message }) => {
			const { t, runId, claimId, executionSecret } = await startedChatGptRun();
			const { name, entries, credential } = await chatGptVault(Date.now() - 1);
			let recovered = false;
			stubProviderFetch(entries, (url) => {
				if (!url.endsWith('/oauth/token')) throw new Error(`Unexpected provider request: ${url}`);
				if (!recovered)
					return error ? Response.json(error, { status }) : new Response(null, { status });
				return Response.json({
					access_token: 'access-recovered',
					refresh_token: 'refresh-recovered',
					expires_in: 3_600
				});
			});
			const args = { runId, claimId, executionSecret };
			await expect(t.action(api.providerCredentials.issueChatGptCredential, args)).rejects.toThrow(
				message
			);
			expect(JSON.parse(entries.get(name)!.value)).toEqual(credential);
			await expect(
				t.query(api.providerCredentials.chatGptConnection, { runId, executionSecret })
			).resolves.toBe('connection-1');
			recovered = true;
			await expect(
				t.action(api.providerCredentials.issueChatGptCredential, args)
			).resolves.toMatchObject({ accessToken: 'access-recovered', connectionId: 'connection-1' });
			expect(JSON.parse(entries.get(name)!.value)).toMatchObject({
				refreshToken: 'refresh-recovered'
			});
		}
	);

	it('preserves the session after a network failure and refreshes on retry', async () => {
		const { t, runId, claimId, executionSecret } = await startedChatGptRun();
		const { name, entries, credential } = await chatGptVault(Date.now() - 1);
		let calls = 0;
		stubProviderFetch(entries, (url) => {
			if (!url.endsWith('/oauth/token')) throw new Error(`Unexpected provider request: ${url}`);
			if (calls++ === 0) throw new TypeError('Network unavailable');
			return Response.json({ access_token: 'access-recovered', expires_in: 3_600 });
		});
		const args = { runId, claimId, executionSecret };
		await expect(t.action(api.providerCredentials.issueChatGptCredential, args)).rejects.toThrow(
			'Network unavailable'
		);
		expect(JSON.parse(entries.get(name)!.value)).toEqual(credential);
		await expect(
			t.action(api.providerCredentials.issueChatGptCredential, args)
		).resolves.toMatchObject({ accessToken: 'access-recovered' });
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

	it.each([false, true])(
		'revokes the ChatGPT session and deletes credentials with reportRevocation=%s',
		async (reportRevocation) => {
			const { t, asUser, runId, executionSecret } = await startedChatGptRun();
			const { name, entries } = await chatGptVault();
			const fetchMock = stubProviderFetch(entries, async (url, init) => {
				if (url === 'https://auth.openai.com/oauth/revoke') {
					expect(init?.method).toBe('POST');
					expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
					expect(JSON.parse(String(init?.body))).toEqual({
						token: 'refresh-current',
						token_type_hint: 'refresh_token',
						client_id: 'app_EMoamEEZ73f0CkXaXp7hrann'
					});
					expect(entries.has(name)).toBe(true);
					await expect(
						t.query(api.providerCredentials.chatGptConnection, { runId, executionSecret })
					).resolves.toBeNull();
					return new Response(null, { status: 200 });
				}
				throw new Error(`Unexpected provider request: ${url}`);
			});
			await t.mutation(internal.providerCredentials.acquireChatGptCredentialLease, {
				userId: 'user_alice',
				leaseId: 'setup'
			});
			await t.run(async (ctx) => {
				const state = await ctx.db
					.query('providerCredentialStates')
					.withIndex('by_userId', (query) => query.eq('userId', 'user_alice'))
					.unique();
				if (!state) throw new Error('Missing credential state');
				await ctx.db.patch(state._id, {
					modelIds: ['gpt-5.4'],
					lease: undefined
				});
			});

			await expect(
				asUser.action(
					api.providerCredentials.removeChatGptCredential,
					reportRevocation ? { reportRevocation: true } : {}
				)
			).resolves.toEqual(reportRevocation ? { revoked: true } : null);
			expect(entries.has(name)).toBe(false);
			const deletion = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE');
			expect(new URL(String(deletion?.[0])).searchParams.get('version_check')).toBe(
				'version_secret_1'
			);
			await expect(
				t.query(internal.providerCredentials.getChatGptConfiguration, {
					userId: 'user_alice'
				})
			).resolves.toEqual({ connectionId: null, modelIds: null });
		}
	);

	it('preserves a replacement Vault credential when invalid-session cleanup finds a version conflict', async () => {
		const { t, runId, claimId, executionSecret } = await startedChatGptRun();
		const { name, entries, credential } = await chatGptVault(Date.now() - 1);
		const replacement = {
			...credential,
			connectionId: 'connection-2',
			refreshToken: 'refresh-new'
		};
		stubProviderFetch(entries, (url) => {
			if (!url.endsWith('/oauth/token')) throw new Error(`Unexpected provider request: ${url}`);
			entries.set(name, {
				...entries.get(name)!,
				value: JSON.stringify(replacement),
				metadata: { version_id: 'version-new' }
			});
			return Response.json({ error: 'invalid_grant' }, { status: 400 });
		});
		await expect(
			t.action(api.providerCredentials.issueChatGptCredential, { runId, claimId, executionSecret })
		).rejects.toThrow('Couldn’t remove the provider credential');
		expect(JSON.parse(entries.get(name)!.value)).toEqual(replacement);
		await expect(
			t
				.withIdentity({ subject: 'user_alice' })
				.action(api.providerCredentials.getMyConfiguration, {})
		).resolves.toEqual({ openai: false, chatgpt: false, chatgptModelIds: null });
	});

	it.each(['disconnect', 'refresh'] as const)(
		'reports disconnected after %s cleanup fails to delete a Vault credential',
		async (operation) => {
			const { t, asUser, runId, claimId, executionSecret } = await startedChatGptRun();
			const { name, entries, credential } = await chatGptVault(
				operation === 'refresh' ? Date.now() - 1 : Date.now() + 60_000
			);
			const fetchVault = stubProviderFetch(entries, (url) => {
				if (url.endsWith('/oauth/revoke')) return new Response(null, { status: 200 });
				if (url.endsWith('/oauth/token')) {
					return Response.json({ error: 'invalid_grant' }, { status: 400 });
				}
				throw new Error(`Unexpected provider request: ${url}`);
			});
			vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) =>
				init?.method === 'DELETE'
					? Promise.resolve(new Response(null, { status: 503 }))
					: fetchVault(input, init)
			);
			await expect(asUser.action(api.providerCredentials.getMyConfiguration, {})).resolves.toEqual({
				openai: false,
				chatgpt: true,
				chatgptModelIds: null
			});
			const cleanup =
				operation === 'disconnect'
					? asUser.action(api.providerCredentials.removeChatGptCredential, {
							reportRevocation: true
						})
					: t.action(api.providerCredentials.issueChatGptCredential, {
							runId,
							claimId,
							executionSecret
						});
			await expect(cleanup).rejects.toThrow('Couldn’t remove the provider credential');
			expect(JSON.parse(entries.get(name)!.value)).toEqual(credential);
			await expect(asUser.action(api.providerCredentials.getMyConfiguration, {})).resolves.toEqual({
				openai: false,
				chatgpt: false,
				chatgptModelIds: null
			});
			await expect(
				t.query(api.providerCredentials.chatGptConnection, { runId, executionSecret })
			).resolves.toBeNull();
		}
	);

	it('preserves a replacement session when revocation finishes after a lease takeover', async () => {
		const { t, asUser } = await startedChatGptRun();
		const { name, entries, credential } = await chatGptVault();
		const revocation = Promise.withResolvers<Response>();
		let started = false;
		stubProviderFetch(entries, (url) => {
			if (!url.endsWith('/oauth/revoke')) throw new Error(`Unexpected provider request: ${url}`);
			started = true;
			return revocation.promise;
		});
		const disconnecting = asUser.action(api.providerCredentials.removeChatGptCredential, {
			reportRevocation: true
		});
		await vi.waitFor(() => expect(started).toBe(true));
		await t.run(async (ctx) => {
			const state = await ctx.db
				.query('providerCredentialStates')
				.withIndex('by_userId', (query) => query.eq('userId', 'user_alice'))
				.unique();
			if (!state) throw new Error('Missing credential state');
			await ctx.db.patch(state._id, {
				connectionId: 'connection-2',
				lease: { id: 'replacement', expiresAt: Date.now() + 90_000 }
			});
		});
		const replacement = {
			...credential,
			connectionId: 'connection-2',
			refreshToken: 'refresh-new'
		};
		entries.set(name, {
			...entries.get(name)!,
			value: JSON.stringify(replacement),
			metadata: { version_id: 'version-new' }
		});
		revocation.resolve(new Response(null, { status: 200 }));
		await expect(disconnecting).rejects.toThrow('ChatGPT credential update lost its lease');
		expect(JSON.parse(entries.get(name)!.value)).toEqual(replacement);
	});

	it.each(['network', 'server'] as const)(
		'retries %s revocation failures before deleting the credential',
		async (failure) => {
			const { asUser } = await startedChatGptRun();
			const { name, entries } = await chatGptVault();
			let attempts = 0;
			stubProviderFetch(entries, (url) => {
				if (!url.endsWith('/oauth/revoke')) throw new Error(`Unexpected provider request: ${url}`);
				expect(entries.has(name)).toBe(true);
				if (++attempts === 1) {
					if (failure === 'network') throw new TypeError('Network unavailable');
					return new Response(null, { status: 503 });
				}
				return new Response(null, { status: 200 });
			});
			await expect(
				asUser.action(api.providerCredentials.removeChatGptCredential, { reportRevocation: true })
			).resolves.toEqual({ revoked: true });
			expect(attempts).toBe(2);
			expect(entries.has(name)).toBe(false);
		}
	);

	it.each([400, 503])(
		'clears local credentials and reports unconfirmed revocation after HTTP %s',
		async (status) => {
			const { t, asUser, runId, executionSecret } = await startedChatGptRun();
			const { name, entries } = await chatGptVault();
			let attempts = 0;
			stubProviderFetch(entries, (url) => {
				if (!url.endsWith('/oauth/revoke')) throw new Error(`Unexpected provider request: ${url}`);
				attempts += 1;
				return new Response(null, { status });
			});
			await expect(
				asUser.action(api.providerCredentials.removeChatGptCredential, { reportRevocation: true })
			).resolves.toEqual({ revoked: false });
			expect(attempts).toBe(status === 503 ? 3 : 1);
			expect(entries.has(name)).toBe(false);
			await expect(
				t.query(api.providerCredentials.chatGptConnection, { runId, executionSecret })
			).resolves.toBeNull();
		}
	);

	it('allows removal of a malformed credential and reports unconfirmed revocation', async () => {
		const { asUser } = await startedChatGptRun();
		const { name, entries } = await chatGptVault();
		entries.get(name)!.value = 'invalid-json';
		stubProviderFetch(entries, (url) => {
			throw new Error(`Unexpected provider request: ${url}`);
		});
		await expect(asUser.action(api.providerCredentials.getMyConfiguration, {})).resolves.toEqual({
			openai: false,
			chatgpt: false,
			chatgptModelIds: null
		});
		await expect(
			asUser.action(api.providerCredentials.removeChatGptCredential, { reportRevocation: true })
		).resolves.toEqual({ revoked: false });
		expect(entries.has(name)).toBe(false);
	});
});
