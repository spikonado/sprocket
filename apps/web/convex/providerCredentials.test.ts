import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { patchRunExecution } from '@convex/lib/runExecution';
import { api, internal } from './_generated/api';
import {
	initConvexTest,
	insertQueuedRun,
	seedOwnedThread,
	type ConvexTestInstance
} from './test.setup';

type VaultEntry = {
	id: string;
	name: string;
	value: string;
	metadata: { version_id: string };
};

function vaultEntry(name: string, value: string, id = 'secret_1'): VaultEntry {
	return { id, name, value, metadata: { version_id: `version_${id}` } };
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

		if (parsedUrl.pathname === '/vault/v1/kv') {
			const limit = Number(parsedUrl.searchParams.get('limit') ?? 10);
			const after = parsedUrl.searchParams.get('after');
			const all = [...entries.values()];
			const start = after ? all.findIndex((entry) => entry.id === after) + 1 : 0;
			const page = all.slice(Math.max(start, 0), Math.max(start, 0) + limit);
			const last = page.at(-1);

			return Response.json({
				data: page.map((entry) => ({ id: entry.id, name: entry.name })),
				list_metadata: last && start + page.length < all.length ? { after: last.id } : {}
			});
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

		if (!init?.method || init.method === 'GET') return Response.json(entry);

		return new Response(null, { status: 405 });
	});

	vi.stubGlobal('fetch', fetchMock);

	return fetchMock;
}

async function drainRetirement(t: ConvexTestInstance): Promise<void> {
	await t.finishAllScheduledFunctions(vi.runAllTimers);
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

	it('reports ChatGPT as disconnected while preserving the OpenAI configuration', async () => {
		const t = initConvexTest();
		const asUser = t.withIdentity({ subject: 'user_alice' });
		vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
		await expect(asUser.action(api.providerCredentials.getMyConfiguration, {})).resolves.toEqual({
			openai: false,
			chatgpt: false,
			chatgptModelIds: null
		});

		stubProviderFetch(new Map(), () => new Response('{}'));
		await asUser.action(api.providerCredentials.saveOpenAiKey, { apiKey: 'sk-user' });
		await expect(asUser.action(api.providerCredentials.getMyConfiguration, {})).resolves.toEqual({
			openai: true,
			chatgpt: false,
			chatgptModelIds: null
		});
	});

	it.each([
		'beginChatGptBrowserLogin',
		'completeChatGptBrowserLogin',
		'cancelChatGptBrowserLogin',
		'beginChatGptDeviceLogin',
		'pollChatGptDeviceLogin',
		'cancelChatGptDeviceLogin',
		'refreshChatGptModels',
		'removeChatGptCredential',
		'issueChatGptCredential'
	] as const)('rejects the retired %s cloud flow with local SIWC guidance', async (name) => {
		const { t, runId, claimId, executionSecret } = await startedChatGptRun();
		const asUser = t.withIdentity({ subject: 'user_alice' });

		const callArgs =
			name === 'issueChatGptCredential'
				? { runId, claimId, executionSecret }
				: name === 'beginChatGptDeviceLogin' ||
					  name === 'refreshChatGptModels' ||
					  name === 'removeChatGptCredential'
					? {}
					: name === 'beginChatGptBrowserLogin' || name === 'cancelChatGptBrowserLogin'
						? { state: 'a'.repeat(64) }
						: name === 'completeChatGptBrowserLogin'
							? { state: 'a'.repeat(64), code: 'browser-code' }
							: { deviceAuthId: 'device-1', userCode: 'ABCD-EFGH' };

		// SAFETY: callArgs matches the original validator for each endpoint in this table.
		await expect(asUser.action(api.providerCredentials[name], callArgs as never)).rejects.toThrow(
			'Cloud-held ChatGPT sign-in is retired.'
		);
	});

	it('reports no connection for historical chatgpt runs and guards the run secret', async () => {
		const { t, runId, executionSecret } = await startedChatGptRun();

		const connection = (secret: string) =>
			t.query(api.providerCredentials.chatGptConnection, { runId, executionSecret: secret });

		await expect(connection('wrong-secret')).rejects.toThrow('Run not found.');
		await expect(connection(executionSecret)).resolves.toBeNull();

		await t.run(async (ctx) => {
			await ctx.db.patch('runs', runId, { completionProvider: 'openai' });
		});
		await expect(connection(executionSecret)).rejects.toThrow(
			'Run is not configured to use ChatGPT.'
		);
	});

	it('retires stored ChatGPT credentials, their metadata, and Vault-only leftovers', async () => {
		vi.useFakeTimers();
		const t = initConvexTest();
		const revocations: string[] = [];
		const aliceName = await providerCredentialName('sprocket-chatgpt-', 'user_alice');
		const bobName = await providerCredentialName('sprocket-chatgpt-', 'user_bob');
		const orphanName = 'sprocket-chatgpt-orphaned';
		const openAiName = await providerCredentialName('sprocket-openai-', 'user_alice');

		const credential = (refreshToken: string) =>
			JSON.stringify({
				version: 1,
				connectionId: 'connection-1',
				accessToken: 'access-current',
				refreshToken,
				accountId: 'account-1',
				expiresAt: Date.now() + 60 * 60 * 1_000
			});

		const entries = new Map<string, VaultEntry>([
			[aliceName, vaultEntry(aliceName, credential('refresh-alice'), 'secret_alice')],
			[bobName, vaultEntry(bobName, 'not json at all', 'secret_bob')],
			[orphanName, vaultEntry(orphanName, credential('refresh-orphan'), 'secret_orphan')],
			[openAiName, vaultEntry(openAiName, 'sk-user', 'secret_openai')]
		]);

		// Bob has a Vault object without a metadata row (metadata gap).
		await t.run(async (ctx) => {
			await ctx.db.insert('providerCredentialStates', {
				userId: 'user_alice',
				connectionId: 'connection-1',
				modelIds: ['gpt-5.4']
			});
		});
		stubProviderFetch(entries, (url, init) => {
			if (url.endsWith('/oauth/revoke')) {
				revocations.push(new URLSearchParams(String(init?.body)).get('token') ?? '');

				return new Response(null, { status: 400 });
			}

			throw new Error(`Unexpected provider request: ${url}`);
		});

		await t.action(internal.providerCredentials.retireChatGptCloudCredentials, {
			cursor: null,
			vaultAfter: null,
			tableScanDone: false
		});
		await drainRetirement(t);

		expect(entries.has(aliceName)).toBe(false);
		expect(entries.has(bobName)).toBe(false);
		expect(entries.has(orphanName)).toBe(false);
		expect(entries.get(openAiName)?.value).toBe('sk-user');
		expect(revocations.sort()).toEqual(['refresh-alice', 'refresh-orphan']);
		expect(
			await t.run((ctx) =>
				ctx.db
					.query('providerCredentialStates')
					.withIndex('by_userId', (query) => query.eq('userId', 'user_alice'))
					.unique()
			)
		).toBeNull();
	});

	it('retires multiple Vault pages without deleting a pagination cursor early', async () => {
		vi.useFakeTimers();
		const t = initConvexTest();
		const entries = new Map<string, VaultEntry>();

		for (let index = 0; index < 11; index += 1) {
			const name = `sprocket-chatgpt-orphan-${index}`;
			entries.set(name, vaultEntry(name, 'invalid legacy data', `secret_${index}`));
		}

		const fetch = stubProviderFetch(entries, (url) => {
			throw new Error(`Unexpected provider request: ${url}`);
		});

		await t.action(internal.providerCredentials.retireChatGptCloudCredentials, {
			cursor: null,
			vaultAfter: null,
			tableScanDone: true
		});
		await drainRetirement(t);
		expect(entries.size).toBe(0);
		expect(
			fetch.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/vault/v1/kv')
		).toHaveLength(3);
	});

	it('keeps metadata and retries when Vault deletion fails', async () => {
		vi.useFakeTimers();
		const t = initConvexTest();
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

		await t.run(async (ctx) => {
			await ctx.db.insert('providerCredentialStates', {
				userId: 'user_alice',
				connectionId: 'connection-1'
			});
		});
		let vaultDeletes = 0;
		let failing = true;

		const vaultFetch = stubProviderFetch(entries, (url) => {
			if (url.endsWith('/oauth/revoke')) return new Response(null, { status: 401 });
			throw new Error(`Unexpected provider request: ${url}`);
		});

		vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
			if (init?.method === 'DELETE' && failing) {
				vaultDeletes += 1;

				return new Response(null, { status: 500 });
			}

			return vaultFetch(input, init);
		});

		await expect(
			t.action(internal.providerCredentials.retireChatGptCloudCredentials, {
				cursor: null,
				vaultAfter: null,
				tableScanDone: false
			})
		).rejects.toThrow('Couldn’t remove the provider credential from WorkOS Vault.');
		expect(vaultDeletes).toBe(1);
		expect(
			await t.run((ctx) =>
				ctx.db
					.query('providerCredentialStates')
					.withIndex('by_userId', (query) => query.eq('userId', 'user_alice'))
					.unique()
			)
		).not.toBeNull();
		expect(entries.has(name)).toBe(true);

		failing = false;
		await t.action(internal.providerCredentials.retireChatGptCloudCredentials, {
			cursor: null,
			vaultAfter: null,
			tableScanDone: false
		});
		await drainRetirement(t);
		expect(entries.has(name)).toBe(false);
		expect(
			await t.run((ctx) =>
				ctx.db
					.query('providerCredentialStates')
					.withIndex('by_userId', (query) => query.eq('userId', 'user_alice'))
					.unique()
			)
		).toBeNull();
	});

	it('retries revocation only twice before deleting the Vault credential', async () => {
		vi.useFakeTimers();
		const t = initConvexTest();
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
						refreshToken: 'refresh-flaky',
						accountId: 'account-1',
						expiresAt: Date.now() + 60 * 60 * 1_000
					})
				)
			]
		]);

		await t.run(async (ctx) => {
			await ctx.db.insert('providerCredentialStates', { userId: 'user_alice' });
		});
		let revocationAttempts = 0;
		stubProviderFetch(entries, (url) => {
			if (url.endsWith('/oauth/revoke')) {
				revocationAttempts += 1;

				return new Response(null, { status: 500 });
			}

			throw new Error(`Unexpected provider request: ${url}`);
		});

		const retirement = t.action(internal.providerCredentials.retireChatGptCloudCredentials, {
			cursor: null,
			vaultAfter: null,
			tableScanDone: false
		});

		await vi.waitFor(() => expect(revocationAttempts).toBe(1));
		await vi.advanceTimersByTimeAsync(250);
		await retirement;
		await drainRetirement(t);

		expect(revocationAttempts).toBe(2);
		expect(entries.has(name)).toBe(false);
		expect(
			await t.run((ctx) =>
				ctx.db
					.query('providerCredentialStates')
					.withIndex('by_userId', (query) => query.eq('userId', 'user_alice'))
					.unique()
			)
		).toBeNull();
	});
});
