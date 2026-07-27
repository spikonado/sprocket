import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { initConvexTest } from './test.setup';

describe('providerSettings', () => {
	it('returns default preference and empty credential status', async () => {
		const t = initConvexTest();
		const asUser = t.withIdentity({ subject: 'user_providers' });
		await expect(asUser.query(api.providerSettings.getMine, {})).resolves.toEqual({
			providers: ['convex', 'chatgpt', 'openai'],
			credentials: [
				{ provider: 'chatgpt', configured: false, keyHint: null, updatedAt: null },
				{ provider: 'openai', configured: false, keyHint: null, updatedAt: null }
			]
		});
	});

	it('persists provider order with normalization', async () => {
		const t = initConvexTest();
		const asUser = t.withIdentity({ subject: 'user_providers_order' });
		await expect(
			asUser.mutation(api.providerSettings.setProviderOrder, { providers: ['openai'] })
		).resolves.toEqual({ providers: ['openai', 'convex', 'chatgpt'] });
		await expect(
			asUser.mutation(api.providerSettings.setProviderOrder, {
				providers: ['convex', 'chatgpt', 'openai']
			})
		).resolves.toEqual({ providers: ['convex', 'chatgpt', 'openai'] });
	});

	it('exposes credential status when a vault ref exists', async () => {
		const t = initConvexTest();
		const asUser = t.withIdentity({ subject: 'user_providers_cred' });
		await t.run(async (ctx) => {
			await ctx.db.insert('providerCredentialRefs', {
				userId: 'user_providers_cred',
				provider: 'openai',
				vaultObjectId: 'obj_test',
				keyHint: 'abcd',
				updatedAt: 1_700_000_000_000
			});
		});
		await expect(asUser.query(api.providerSettings.getMine, {})).resolves.toMatchObject({
			credentials: [
				{ provider: 'chatgpt', configured: false },
				{
					provider: 'openai',
					configured: true,
					keyHint: 'abcd',
					updatedAt: 1_700_000_000_000
				}
			]
		});
	});
});
