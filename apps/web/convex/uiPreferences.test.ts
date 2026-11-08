import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { initConvexTest } from './test.setup';

describe('theme preferences', () => {
	it.each([
		['automaticThreadTitles', api.uiPreferences.setAutomaticThreadTitles],
		['automaticAgentContinuation', api.uiPreferences.setAutomaticAgentContinuation],
		['restrictSubagentsToProvider', api.uiPreferences.setRestrictSubagentsToProvider],
		['shareConversationContent', api.uiPreferences.setShareConversationContent]
	] as const)('syncs %s per account and preserves the theme', async (field, setPreference) => {
		const t = initConvexTest();
		const alice = t.withIdentity({ subject: 'alice' });
		const otherSession = t.withIdentity({ subject: 'alice' });
		const bob = t.withIdentity({ subject: 'bob' });
		await alice.mutation(api.uiPreferences.setTheme, { theme: 'dark' });
		await alice.mutation(setPreference, { enabled: false });
		expect(await otherSession.query(api.uiPreferences.getMine, {})).toMatchObject({
			theme: 'dark',
			[field]: false
		});
		await otherSession.mutation(api.uiPreferences.setTheme, { theme: 'light' });
		expect(await alice.query(api.uiPreferences.getMine, {})).toMatchObject({
			theme: 'light',
			[field]: false
		});
		await bob.mutation(setPreference, { enabled: true });
		expect(await bob.query(api.uiPreferences.getMine, {})).toMatchObject({ [field]: true });
		expect(await alice.query(api.uiPreferences.getMine, {})).toMatchObject({ [field]: false });
		await expect(t.mutation(setPreference, { enabled: false })).rejects.toThrow(
			'Authentication required'
		);
	});

	it('syncs themes between sessions while isolating accounts', async () => {
		const t = initConvexTest();
		const alice = t.withIdentity({ subject: 'alice' });
		const otherAliceSession = t.withIdentity({ subject: 'alice' });
		const bob = t.withIdentity({ subject: 'bob' });
		expect(await alice.query(api.uiPreferences.getMine, {})).toBeNull();

		const saved = await alice.mutation(api.uiPreferences.setTheme, { theme: 'dark' });
		expect(await otherAliceSession.query(api.uiPreferences.getMine, {})).toEqual(saved);
		expect(await bob.query(api.uiPreferences.getMine, {})).toBeNull();

		const updated = await otherAliceSession.mutation(api.uiPreferences.setTheme, {
			theme: 'light'
		});

		expect(updated?._id).toBe(saved?._id);
		expect(await alice.query(api.uiPreferences.getMine, {})).toMatchObject({ theme: 'light' });
		await expect(t.query(api.uiPreferences.getMine, {})).rejects.toThrow('Authentication required');
	});

	it('lists enabled providers in the saved order', async () => {
		const alice = initConvexTest().withIdentity({ subject: 'alice' });
		expect(await alice.query(api.uiPreferences.getMyEnabledProviders, {})).toEqual([
			'spikonado',
			'openai',
			'chatgpt'
		]);
		expect(
			await alice.query(api.uiPreferences.getMyEnabledProviders, {
				knownProviders: ['spikonado', 'claude', 'anthropic', 'vercel', 'openrouter']
			})
		).toEqual(['spikonado', 'claude', 'anthropic', 'vercel', 'openrouter']);

		await alice.mutation(api.uiPreferences.setProviderOrder, {
			providerOrder: [
				{ provider: 'chatgpt', enabled: true },
				{ provider: 'spikonado', enabled: false },
				{ provider: 'openai', enabled: true }
			]
		});

		expect(await alice.query(api.uiPreferences.getMyEnabledProviders, {})).toEqual([
			'chatgpt',
			'openai'
		]);
		expect(
			await alice.query(api.uiPreferences.getMyEnabledProviders, {
				knownProviders: ['openai', 'chatgpt', 'spikonado', 'anthropic']
			})
		).toEqual(['chatgpt', 'openai', 'anthropic']);
	});

	it('rejects a provider order that disables every provider', async () => {
		const alice = initConvexTest().withIdentity({ subject: 'alice' });

		await expect(
			alice.mutation(api.uiPreferences.setProviderOrder, {
				providerOrder: [
					{ provider: 'chatgpt', enabled: false },
					{ provider: 'spikonado', enabled: false },
					{ provider: 'openai', enabled: false }
				]
			})
		).rejects.toThrow('at least one enabled');
	});
});
