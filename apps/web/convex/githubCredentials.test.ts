import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { executionSecretHash } from '@convex/lib/auth';
import { api } from './_generated/api';
import { initConvexTest } from './test.setup';

type VaultEntry = { id: string; name: string; value: string; metadata: { version_id: string } };

/** An in-memory WorkOS Vault that enforces `version_check` like the real one. */
function stubVault(): Map<string, VaultEntry> {
	const entries = new Map<string, VaultEntry>();
	let versions = 0;
	const nextVersion = () => `version_${(versions += 1)}`;

	vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const byName = url.pathname.match(/^\/vault\/v1\/kv\/name\/(.+)$/);
		const byId = url.pathname.match(/^\/vault\/v1\/kv\/([^/]+)$/);
		const entryWithId = (id: string) => [...entries.values()].find((entry) => entry.id === id);

		if (byName) {
			const entry = entries.get(decodeURIComponent(byName[1]!));

			return entry ? Response.json(entry) : new Response(null, { status: 404 });
		}

		if (init?.method === 'POST' && url.pathname === '/vault/v1/kv') {
			const body = z
				.object({ name: z.string(), value: z.string() })
				.parse(JSON.parse(String(init.body)));

			const entry = {
				id: `secret_${entries.size + 1}`,
				...body,
				metadata: { version_id: nextVersion() }
			};

			entries.set(entry.name, entry);

			return Response.json(entry);
		}

		const entry = byId ? entryWithId(decodeURIComponent(byId[1]!)) : undefined;

		if (!entry) return new Response(null, { status: 404 });

		if (init?.method === 'PUT') {
			const body = z
				.object({ value: z.string(), version_check: z.string() })
				.parse(JSON.parse(String(init.body)));

			if (body.version_check !== entry.metadata.version_id)
				return new Response(null, { status: 409 });
			entries.set(entry.name, {
				...entry,
				value: body.value,
				metadata: { version_id: nextVersion() }
			});

			return Response.json(entries.get(entry.name));
		}

		if (init?.method === 'DELETE') {
			if (url.searchParams.get('version_check') !== entry.metadata.version_id) {
				return new Response(null, { status: 409 });
			}

			entries.delete(entry.name);

			return new Response(null, { status: 204 });
		}

		return new Response(null, { status: 405 });
	});

	return entries;
}

async function registerMachine(t: ReturnType<typeof initConvexTest>, userId: string) {
	const credentialHash = await executionSecretHash('machine-credential');

	await t.run((ctx) =>
		ctx.db.insert('machines', {
			userId,
			machineId: 'machine-a',
			friendlyName: 'Laptop',
			platform: 'linux',
			platformVersion: '6',
			architecture: 'arm64',
			hostname: 'laptop',
			appVersion: '1.0.0',
			credentialHash,
			lastSeenAt: Date.now(),
			runIds: [],
			updatedAt: Date.now()
		})
	);
}

describe('GitHub credentials', () => {
	beforeEach(() => {
		vi.stubEnv('WORKOS_API_KEY', 'sk_workos_test');
		vi.stubEnv('WORKOS_CLIENT_ID', 'client_test');
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it('hands the saved tokens to a registered machine of the same user', async () => {
		const vault = stubVault();
		const t = initConvexTest();
		const alice = t.withIdentity({ subject: 'user_alice' });
		await registerMachine(t, 'user_alice');

		await alice.action(api.githubCredentials.saveToken, { host: 'GitHub.com ', token: ' ghp_a ' });
		await alice.action(api.githubCredentials.saveToken, {
			host: 'ghe.acme.com',
			token: 'ghp_acme'
		});
		await alice.action(api.githubCredentials.removeToken, { host: 'github.com' });

		expect(vault.size).toBe(1);
		await expect(
			alice.action(api.githubCredentials.issueTokens, {
				machineId: 'machine-a',
				credential: 'machine-credential'
			})
		).resolves.toEqual({ 'ghe.acme.com': 'ghp_acme' });

		await alice.action(api.githubCredentials.removeToken, { host: 'ghe.acme.com' });
		expect(vault.size).toBe(0);
	});

	it('refuses tokens to callers without the machine credential', async () => {
		stubVault();
		const t = initConvexTest();
		await registerMachine(t, 'user_alice');
		const alice = t.withIdentity({ subject: 'user_alice' });
		const bob = t.withIdentity({ subject: 'user_bob' });
		await alice.action(api.githubCredentials.saveToken, { host: 'github.com', token: 'ghp_a' });

		for (const [caller, credential] of [
			[alice, 'browser-guess'],
			[bob, 'machine-credential']
		] as const) {
			await expect(
				caller.action(api.githubCredentials.issueTokens, { machineId: 'machine-a', credential })
			).rejects.toThrow('Machine is not active.');
		}
	});
});
