// @vitest-environment jsdom
import posthog from 'posthog-js';
import { expect, it, vi } from 'vitest';
import { initAnalytics } from './analytics';
import { authState, type AuthUser } from './auth';

const user: AuthUser = {
	id: 'user-a',
	email: 'a@example.com',
	firstName: null,
	lastName: null,
	profilePictureUrl: null
};

it('keeps the super properties after signing out', () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(() => new Promise(() => {}))
	);
	authState.set({ ...authState.getSnapshot(), isReady: true, isLoading: false, user });
	initAnalytics({ env: { PUBLIC_POSTHOG_KEY: 'phc_test' }, machine: false, version: '1.2.3' });
	expect(posthog.get_distinct_id()).toBe(user.id);

	authState.update((state) => ({ ...state, user: null }));

	expect(posthog.get_distinct_id()).not.toBe(user.id);
	expect(posthog.get_property('site')).toBe('sprocket_app');
	expect(posthog.get_property('app_version')).toBe('1.2.3');
});
