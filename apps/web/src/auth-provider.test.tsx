import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { authState, convexAuthRetryVersion, type AuthUser } from '$lib/auth';
import { useSprocketAuth } from './auth-provider';

const initialState = authState.getSnapshot();
const initialRetryVersion = convexAuthRetryVersion.getSnapshot();
const user: AuthUser = {
	id: 'user-a',
	email: 'a@example.com',
	firstName: null,
	lastName: null,
	profilePictureUrl: null
};

afterEach(() => {
	authState.set(initialState);
	convexAuthRetryVersion.set(initialRetryVersion);
});

it('reinstalls the Convex token fetcher for recovery and account changes, not token refreshes', () => {
	authState.set({ ...initialState, isReady: true, isLoading: false, user });
	const { result } = renderHook(useSprocketAuth);
	const firstFetcher = result.current.fetchAccessToken;
	act(() => authState.update((state) => ({ ...state, user: { ...user }, nativeSession: 'ready' })));
	expect(result.current.fetchAccessToken).toBe(firstFetcher);
	act(() => convexAuthRetryVersion.update((version) => version + 1));
	const recoveredFetcher = result.current.fetchAccessToken;
	expect(recoveredFetcher).not.toBe(firstFetcher);
	act(() => authState.update((state) => ({ ...state, user: { ...user, id: 'user-b' } })));
	expect(result.current.fetchAccessToken).not.toBe(recoveredFetcher);
	expect(result.current).toMatchObject({ isLoading: false, isAuthenticated: true });
	act(() => authState.update((state) => ({ ...state, user: null })));
	expect(result.current.isAuthenticated).toBe(false);
});
