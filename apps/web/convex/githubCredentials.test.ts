import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './_generated/api';
import { initConvexTest, stubVault } from './test.setup';

describe('GitHub credentials', () => {
	beforeEach(() => {
		vi.stubEnv('WORKOS_API_KEY', 'sk_workos_test');
		vi.stubEnv('WORKOS_CLIENT_ID', 'client_test');
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it('hands the saved tokens back to the same user', async () => {
		const vault = stubVault();
		const t = initConvexTest();
		const alice = t.withIdentity({ subject: 'user_alice' });

		await alice.action(api.githubCredentials.saveToken, { host: 'GitHub.com ', token: ' ghp_a ' });
		await alice.action(api.githubCredentials.saveToken, {
			host: 'ghe.acme.com',
			token: 'ghp_acme'
		});
		await alice.action(api.githubCredentials.removeToken, { host: 'github.com' });

		expect(vault.size).toBe(1);
		await expect(alice.action(api.githubCredentials.issueTokens, {})).resolves.toEqual({
			'ghe.acme.com': 'ghp_acme'
		});
		await expect(
			t.withIdentity({ subject: 'user_bob' }).action(api.githubCredentials.issueTokens, {})
		).resolves.toEqual({});

		await alice.action(api.githubCredentials.removeToken, { host: 'ghe.acme.com' });
		expect(vault.size).toBe(0);
	});
});
