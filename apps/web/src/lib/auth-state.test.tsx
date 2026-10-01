import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useEffect } from 'react';
import { authState, convexAuthLoading, convexAuthUserId, type AuthUser } from './auth';
import { useStore } from './store';

const initialState = authState.getSnapshot();

const user: AuthUser = {
	id: 'user-a',
	email: 'a@example.com',
	firstName: null,
	lastName: null,
	profilePictureUrl: null
};

afterEach(() => {
	act(() => authState.set(initialState));
});

it('keeps the Convex identity stable through token refreshes and observes account changes', () => {
	authState.set({ ...initialState, isReady: true, isLoading: false, user });
	const identities: (string | null)[] = [];
	const loadingStates: boolean[] = [];
	renderHook(() => {
		const identity = useStore(convexAuthUserId);
		const loading = useStore(convexAuthLoading);
		useEffect(() => {
			identities.push(identity);
		}, [identity]);
		useEffect(() => {
			loadingStates.push(loading);
		}, [loading]);
	});

	for (let refresh = 0; refresh < 5; refresh += 1) {
		act(() => authState.update((state) => ({ ...state, user: { ...user }, error: null })));
	}

	act(() => authState.update((state) => ({ ...state, nativeSession: 'ready', error: 'UI error' })));
	expect(identities).toEqual(['user-a']);
	expect(loadingStates).toEqual([false]);
	act(() => authState.update((state) => ({ ...state, user: { ...user, id: 'user-b' } })));
	act(() => authState.update((state) => ({ ...state, user: null })));
	expect(identities).toEqual(['user-a', 'user-b', null]);
});

it('updates the authentication hook when a manual retry enters and leaves loading', () => {
	authState.set({ ...initialState, isReady: true, isLoading: false, user });
	const { result } = renderHook(() => useStore(convexAuthLoading));
	expect(result.current).toBe(false);
	act(() => authState.update((state) => ({ ...state, isLoading: true })));
	expect(result.current).toBe(true);
	act(() => authState.update((state) => ({ ...state, isLoading: false })));
	expect(result.current).toBe(false);
});
