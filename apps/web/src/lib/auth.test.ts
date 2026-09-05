import { afterEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@workos-inc/authkit-js';
import { get } from 'svelte/store';
import { authState, convexAuthLoading, convexAuthUserId } from './auth';

const initialState = get(authState);
const user: User = {
	object: 'user',
	id: 'user-a',
	email: 'a@example.com',
	firstName: null,
	lastName: null,
	profilePictureUrl: null,
	lastSignInAt: null,
	externalId: undefined,
	emailVerified: true,
	createdAt: '',
	updatedAt: ''
};

afterEach(() => authState.set(initialState));

describe('Convex auth dependencies', () => {
	it('ignores token refreshes and unrelated UI state without hiding account changes', () => {
		authState.set({ ...initialState, isReady: true, isLoading: false, user });
		const identityChanged = vi.fn();
		const loadingChanged = vi.fn();
		const stopIdentity = convexAuthUserId.subscribe(identityChanged);
		const stopLoading = convexAuthLoading.subscribe(loadingChanged);
		try {
			for (let refresh = 0; refresh < 5; refresh += 1) {
				authState.update((state) => ({ ...state, user: { ...user }, error: null }));
			}
			authState.update((state) => ({ ...state, nativeSession: 'ready', error: 'UI error' }));
			expect(identityChanged.mock.calls).toEqual([['user-a']]);
			expect(loadingChanged.mock.calls).toEqual([[false]]);

			authState.update((state) => ({ ...state, user: { ...user, id: 'user-b' } }));
			authState.update((state) => ({ ...state, user: null }));
			expect(identityChanged.mock.calls).toEqual([['user-a'], ['user-b'], [null]]);
		} finally {
			stopIdentity();
			stopLoading();
		}
	});

	it('still notifies Convex when a manual retry enters and leaves loading', () => {
		authState.set({ ...initialState, isReady: true, isLoading: false, user });
		const changed = vi.fn();
		const stop = convexAuthLoading.subscribe(changed);
		try {
			authState.update((state) => ({ ...state, isLoading: true }));
			authState.update((state) => ({ ...state, isLoading: false }));
			expect(changed.mock.calls).toEqual([[false], [true], [false]]);
		} finally {
			stop();
		}
	});
});
