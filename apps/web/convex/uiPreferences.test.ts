import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { initConvexTest } from './test.setup';

describe('theme preferences', () => {
	it.each([
		['automaticThreadTitles', api.uiPreferences.setAutomaticThreadTitles],
		['automaticAgentContinuation', api.uiPreferences.setAutomaticAgentContinuation]
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
});
