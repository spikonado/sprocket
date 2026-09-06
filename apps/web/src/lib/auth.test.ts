import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@workos-inc/authkit-js';
import { get } from 'svelte/store';
import { z } from 'zod';
import {
	authState,
	convexAuthLoading,
	convexAuthUserId,
	convexAuthRetryVersion,
	getAccessToken,
	getConvexAccessToken,
	initializeAuth,
	resetAuthRuntime,
	setAuthRuntime,
	signIn,
	signOut,
	type AuthRuntime
} from './auth';

const createAuthKitClient = vi.fn<AuthRuntime['createAuthKitClient']>();
const ensureLocalSession = vi.fn<AuthRuntime['ensureLocalSession']>();
const readDesktopBootstrap = vi.fn<AuthRuntime['readDesktopBootstrap']>();
const resolveLocalApiBaseUrl = vi.fn<AuthRuntime['resolveLocalApiBaseUrl']>();
const nativeTokenRequestSchema = z.object({ forceRefreshToken: z.boolean() });
type NativeSessionTokenRequest = z.infer<typeof nativeTokenRequestSchema>;
type TestJsonPayload =
	| NativeSessionTokenRequest
	| {
			accessToken: string;
			user: {
				id: string;
				email: string;
				firstName: string | null;
				lastName: string | null;
				profilePictureUrl: string | null;
			};
	  }
	| { error: string }
	| { ok: true }
	| {
			status: 'authenticated' | 'signedOut' | 'pending' | 'unavailable' | 'failed';
			user?: { id: string; email: string };
			error?: string;
	  }
	| { authorizationUrl: string; loginId: string }
	| null;

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
const nativeUser = {
	id: 'user-a',
	email: 'a@example.com',
	firstName: 'Ada',
	lastName: 'Lovelace',
	profilePictureUrl: null
};

afterEach(() => {
	resetAuthRuntime();
	vi.useRealTimers();
	authState.set(initialState);
});

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

describe('installed and hosted auth', () => {
	const bootstrap = {
		httpBaseUrl: 'http://localhost:17731',
		pairingCredential: 'pairing-secret'
	};
	const convexClient = {
		query: vi.fn(async () => ({ workosClientId: 'client_123' }))
	};

	beforeEach(() => {
		resetAuthRuntime();
		createAuthKitClient.mockReset();
		ensureLocalSession.mockReset();
		readDesktopBootstrap.mockReset();
		resolveLocalApiBaseUrl.mockReset();
		convexClient.query.mockClear();
		resolveLocalApiBaseUrl.mockReturnValue('http://localhost:17731');
		readDesktopBootstrap.mockResolvedValue(bootstrap);
		ensureLocalSession.mockResolvedValue(undefined);
		setAuthRuntime({
			createAuthKitClient,
			resolveLocalApiBaseUrl,
			readDesktopBootstrap,
			ensureLocalSession
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('resumes an installed native session without AuthKit JS', async () => {
		stubInstalledWindow();
		const fetch = stubFetch({
			token: () => jsonResponse(200, { accessToken: 'native-token', user: nativeUser })
		});

		await initializeAuth(convexClient);

		expect(createAuthKitClient).not.toHaveBeenCalled();
		expect(ensureLocalSession).toHaveBeenCalledWith('http://localhost:17731', bootstrap);
		expect(fetch).toHaveBeenCalledWith(
			'/api/auth/native-session/token',
			expect.objectContaining({ method: 'POST', credentials: 'include' })
		);
		expect(tokenBodies(fetch)).toEqual([{ forceRefreshToken: false }]);
		expect(get(authState)).toMatchObject({
			isReady: true,
			isLoading: false,
			user: nativeUser,
			nativeSession: 'ready',
			error: null
		});
	});

	it('pairs the local session before asking for a native token', async () => {
		stubInstalledWindow();
		const order: string[] = [];
		readDesktopBootstrap.mockImplementation(async () => {
			order.push('bootstrap');
			return bootstrap;
		});
		ensureLocalSession.mockImplementation(async () => {
			order.push('pair');
		});
		stubFetch({
			token: () => {
				order.push('token');
				return jsonResponse(200, null);
			}
		});

		await initializeAuth(convexClient);

		expect(order).toEqual(['bootstrap', 'pair', 'token']);
		expect(get(authState).user).toBeNull();
		expect(get(authState).nativeSession).toBe('notRequired');
	});

	it('does not delete a native session when legacy AuthKit JS has no user', async () => {
		stubInstalledWindow();
		const fetch = stubFetch({
			token: () => jsonResponse(404, { error: 'not found' }),
			nativeSessionGet: () =>
				jsonResponse(200, {
					status: 'authenticated',
					user: { id: nativeUser.id, email: nativeUser.email }
				})
		});
		createAuthKitClient.mockResolvedValue(mockAuthKitClient(null));

		await initializeAuth(convexClient);

		expect(createAuthKitClient).toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalledWith(
			'/api/auth/native-session',
			expect.objectContaining({ method: 'DELETE' })
		);
		expect(get(authState)).toMatchObject({
			user: null,
			nativeSession: 'missing',
			error: 'Finish setting up sign-in before starting an agent.'
		});
	});

	it('keeps the current native user when a later token refresh is transient', async () => {
		stubInstalledWindow();
		const fetch = stubFetch({
			token: () => jsonResponse(200, { accessToken: 'native-token', user: nativeUser })
		});
		await initializeAuth(convexClient);
		fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (requestUrl(input).includes('/api/auth/native-session/token')) {
				return jsonResponse(503, {
					error: 'Native sign-in is temporarily unavailable. Try again.'
				});
			}
			return unhandled(input, init);
		});

		await initializeAuth(convexClient);

		expect(get(authState)).toMatchObject({
			user: nativeUser,
			nativeSession: 'ready',
			isReady: true,
			isLoading: false
		});
	});

	it('keeps a legacy native session on a transient startup status call', async () => {
		stubInstalledWindow();
		createAuthKitClient.mockResolvedValue(mockAuthKitClient(user));
		stubFetch({
			token: () => jsonResponse(404, { error: 'not found' }),
			nativeSessionGet: () => jsonResponse(503, { error: 'temporarily unavailable' })
		});
		authState.set({
			...get(authState),
			user,
			nativeSession: 'ready',
			isReady: true,
			isLoading: false
		});

		await initializeAuth(convexClient);

		expect(get(authState)).toMatchObject({
			user: { id: 'user-a' },
			nativeSession: 'ready',
			isReady: true
		});
	});

	it('settles Convex token fetch failures and retries without clearing the native user', async () => {
		vi.useFakeTimers();
		stubInstalledWindow();
		let unavailable = false;
		stubFetch({
			token: () =>
				unavailable
					? jsonResponse(503, { error: 'Temporarily unavailable' })
					: jsonResponse(200, { accessToken: 'native-token', user: nativeUser })
		});
		await initializeAuth(convexClient);
		unavailable = true;
		const version = get(convexAuthRetryVersion);
		await expect(getConvexAccessToken({ forceRefreshToken: true })).resolves.toBeNull();
		expect(get(authState).user).toEqual(nativeUser);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(get(convexAuthRetryVersion)).toBe(version + 1);
		unavailable = false;
		await expect(getConvexAccessToken({ forceRefreshToken: true })).resolves.toBe('native-token');
		expect(window.open).not.toHaveBeenCalled();
	});

	it('cancels scheduled Convex recovery when signing out', async () => {
		vi.useFakeTimers();
		stubInstalledWindow();
		let unavailable = false;
		stubFetch({
			token: () =>
				unavailable
					? jsonResponse(503, { error: 'Temporarily unavailable' })
					: jsonResponse(200, { accessToken: 'native-token', user: nativeUser }),
			nativeSessionDelete: () => jsonResponse(200, { ok: true })
		});
		await initializeAuth(convexClient);
		unavailable = true;
		await getConvexAccessToken({ forceRefreshToken: true });
		await signOut();
		const version = get(convexAuthRetryVersion);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(get(convexAuthRetryVersion)).toBe(version);
		expect(get(authState).user).toBeNull();
	});

	it('signs in through PKCE then the native session without a second AuthKit redirect', async () => {
		const { location } = stubInstalledWindow();
		stubFetch({
			desktopStart: () =>
				jsonResponse(200, {
					authorizationUrl: 'https://authkit.example/authorize',
					loginId: 'login-1'
				}),
			desktopResult: () =>
				jsonResponse(200, {
					status: 'authenticated',
					user: { id: nativeUser.id, email: nativeUser.email }
				}),
			token: () => jsonResponse(200, { accessToken: 'native-token', user: nativeUser })
		});

		await signIn();

		expect(createAuthKitClient).not.toHaveBeenCalled();
		expect(location.href).toBe('http://localhost:17731/');
		expect(get(authState)).toMatchObject({
			user: nativeUser,
			nativeSession: 'ready',
			isWaitingForBrowserSignIn: false,
			error: null
		});
	});

	it('maps forceRefreshToken through the native session endpoint and does not persist the token', async () => {
		const { localStorage } = stubInstalledWindow();
		const fetch = stubFetch({
			token: () => jsonResponse(200, { accessToken: 'native-token', user: nativeUser })
		});
		await initializeAuth(convexClient);

		const token = await getAccessToken({ forceRefreshToken: true });

		expect(token).toBe('native-token');
		expect(tokenBodies(fetch)).toEqual([{ forceRefreshToken: false }, { forceRefreshToken: true }]);
		expect(localStorage.setItem).not.toHaveBeenCalled();
		expect(get(authState)).not.toHaveProperty('accessToken');
	});

	it('keeps polling the same login through transient failures', async () => {
		vi.useFakeTimers();
		stubInstalledWindow();
		let polls = 0;
		const fetch = stubFetch({
			desktopStart: () =>
				jsonResponse(200, {
					authorizationUrl: 'https://authkit.example/native',
					loginId: 'login-1'
				}),
			desktopResult: () => {
				polls += 1;
				if (polls === 1) return jsonResponse(503, { error: 'Unavailable' });
				if (polls === 2) return jsonResponse(200, { status: 'unavailable', error: 'Retry' });
				return jsonResponse(200, { status: 'authenticated', user: nativeUser });
			},
			token: () => jsonResponse(200, { accessToken: 'native-token', user: nativeUser })
		});
		const login = signIn();
		await vi.advanceTimersByTimeAsync(3_100);
		await login;
		expect(polls).toBe(3);
		expect(get(authState).user).toEqual(nativeUser);
		expect(fetch.mock.calls.filter(([input]) => requestUrl(input).endsWith('/start'))).toHaveLength(
			1
		);
	});

	it('shares inflight native token requests', async () => {
		stubInstalledWindow();
		const pending = deferred<Response>();
		const fetch = stubFetch({
			token: () => pending.promise
		});

		const first = getAccessToken();
		const second = getAccessToken();
		pending.resolve(jsonResponse(200, { accessToken: 'shared-token', user: nativeUser }));

		expect(await first).toBe('shared-token');
		expect(await second).toBe('shared-token');
		expect(tokenBodies(fetch)).toEqual([{ forceRefreshToken: false }]);
	});

	it('ignores a native token that finishes after an account switch', async () => {
		stubInstalledWindow();
		const pending = deferred<Response>();
		let tokenCalls = 0;
		stubFetch({
			desktopStart: () =>
				jsonResponse(200, {
					authorizationUrl: 'https://authkit.example/authorize',
					loginId: 'login-1'
				}),
			desktopResult: () =>
				jsonResponse(200, {
					status: 'authenticated',
					user: { id: 'user-b', email: 'b@example.com' }
				}),
			token: () => {
				tokenCalls += 1;
				if (tokenCalls === 1) {
					return pending.promise;
				}
				return jsonResponse(200, {
					accessToken: 'b-token',
					user: {
						id: 'user-b',
						email: 'b@example.com',
						firstName: null,
						lastName: null,
						profilePictureUrl: null
					}
				});
			}
		});

		const previousToken = getAccessToken();
		await signIn();
		pending.resolve(jsonResponse(200, { accessToken: 'late-token', user: nativeUser }));

		expect(await previousToken).toBeNull();
		expect(get(authState).user).toMatchObject({ id: 'user-b', email: 'b@example.com' });
	});

	it('ignores a native token that finishes after sign-out', async () => {
		stubInstalledWindow();
		const pending = deferred<Response>();
		stubFetch({
			token: () => pending.promise,
			nativeSessionDelete: () => jsonResponse(200, { ok: true })
		});

		const tokenPromise = getAccessToken();
		await signOut();
		pending.resolve(jsonResponse(200, { accessToken: 'late-token', user: nativeUser }));

		expect(await tokenPromise).toBeNull();
		expect(createAuthKitClient).not.toHaveBeenCalled();
		expect(get(authState)).toMatchObject({
			user: null,
			nativeSession: 'notRequired',
			isLoading: false
		});
	});

	it.each([404, 405])(
		'falls back to AuthKit JS when the native token endpoint is %s',
		async (status) => {
			stubInstalledWindow();
			createAuthKitClient.mockResolvedValue(mockAuthKitClient(user));
			stubFetch({
				token: () => jsonResponse(status, { error: 'missing' }),
				nativeSessionGet: () =>
					jsonResponse(200, {
						status: 'authenticated',
						user: { id: user.id, email: user.email }
					})
			});

			await initializeAuth(convexClient);

			expect(createAuthKitClient).toHaveBeenCalled();
			expect(get(authState)).toMatchObject({
				user: { id: 'user-a', email: 'a@example.com' },
				nativeSession: 'ready',
				error: null
			});
		}
	);

	it('surfaces pairing failure and account mismatch without treating them as signed out', async () => {
		stubInstalledWindow();
		stubFetch({
			token: () => jsonResponse(401, { error: 'authentication required' })
		});
		await initializeAuth(convexClient);
		expect(get(authState)).toMatchObject({
			nativeSession: 'unavailable',
			error: 'authentication required',
			isReady: true
		});

		resetAuthRuntime();
		resolveLocalApiBaseUrl.mockReturnValue('http://localhost:17731');
		readDesktopBootstrap.mockResolvedValue(bootstrap);
		ensureLocalSession.mockResolvedValue(undefined);
		setAuthRuntime({
			createAuthKitClient,
			resolveLocalApiBaseUrl,
			readDesktopBootstrap,
			ensureLocalSession
		});
		stubInstalledWindow();
		stubFetch({
			token: () => jsonResponse(409, { error: 'session belongs to a different account' })
		});
		await initializeAuth(convexClient);
		expect(get(authState)).toMatchObject({
			nativeSession: 'mismatch',
			error: 'session belongs to a different account'
		});
	});

	it('keeps hosted AuthKit JS and inspects SDK state on refresh failure', async () => {
		stubHostedWindow();
		let sdkUser: User | null = user;
		const client = mockAuthKitClient(user);
		client.getUser.mockImplementation(() => sdkUser);
		let onRefreshFailure: (() => void) | undefined;
		createAuthKitClient.mockImplementation(async (_clientId, options) => {
			onRefreshFailure = () => options?.onRefreshFailure?.({ signIn: client.signIn });
			return client;
		});

		await initializeAuth(convexClient);
		expect(ensureLocalSession).not.toHaveBeenCalled();
		expect(get(authState).user).toMatchObject({ id: 'user-a' });

		onRefreshFailure?.();
		expect(get(authState).user).toMatchObject({ id: 'user-a' });
		expect(get(authState).error).toBeNull();

		sdkUser = null;
		onRefreshFailure?.();
		expect(get(authState).user).toBeNull();
		expect(get(authState).error).toBe('Session refresh failed. Sign in again.');
	});
});

function jsonResponse(status: number, payload: TestJsonPayload) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

function requestUrl(input: RequestInfo | URL): string {
	if (input instanceof URL) {
		return input.href;
	}
	if (input instanceof Request) {
		return input.url;
	}
	return input;
}

function tokenBodies(fetch: ReturnType<typeof stubFetch>) {
	const bodies: NativeSessionTokenRequest[] = [];
	for (const [input, init] of fetch.mock.calls) {
		if (!requestUrl(input).includes('/api/auth/native-session/token')) {
			continue;
		}
		if ((init?.method ?? 'GET').toUpperCase() !== 'POST') {
			continue;
		}
		const parsed = nativeTokenRequestSchema.safeParse(JSON.parse(String(init?.body ?? '{}')));
		if (parsed.success) {
			bodies.push(parsed.data);
		}
	}
	return bodies;
}

function unhandled(input: RequestInfo | URL, init?: RequestInit) {
	return jsonResponse(500, {
		error: `unhandled ${init?.method ?? 'GET'} ${requestUrl(input)}`
	});
}

function stubFetch(handlers: {
	token?: (request: NativeSessionTokenRequest) => Response | Promise<Response>;
	nativeSessionGet?: () => Response | Promise<Response>;
	nativeSessionDelete?: () => Response | Promise<Response>;
	desktopStart?: () => Response | Promise<Response>;
	desktopResult?: () => Response | Promise<Response>;
	desktopCancel?: () => Response | Promise<Response>;
}) {
	const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = requestUrl(input);
		const method = (init?.method ?? 'GET').toUpperCase();
		if (url.includes('/api/auth/native-session/token') && method === 'POST') {
			const parsed = nativeTokenRequestSchema.safeParse(JSON.parse(String(init?.body ?? '{}')));
			if (!parsed.success) {
				return jsonResponse(400, { error: 'invalid token request' });
			}
			return handlers.token?.(parsed.data) ?? unhandled(input, init);
		}
		if (url.endsWith('/api/auth/native-session') && method === 'DELETE') {
			return handlers.nativeSessionDelete?.() ?? unhandled(input, init);
		}
		if (url.endsWith('/api/auth/native-session') && method === 'GET') {
			return handlers.nativeSessionGet?.() ?? unhandled(input, init);
		}
		if (url.includes('/api/auth/desktop-login/start') && method === 'POST') {
			return handlers.desktopStart?.() ?? unhandled(input, init);
		}
		if (url.includes('/api/auth/desktop-login/result') && method === 'GET') {
			return handlers.desktopResult?.() ?? unhandled(input, init);
		}
		if (url.includes('/api/auth/desktop-login/cancel') && method === 'POST') {
			return handlers.desktopCancel?.() ?? jsonResponse(200, { ok: true });
		}
		return unhandled(input, init);
	});
	vi.stubGlobal('fetch', fetch);
	return fetch;
}

function stubInstalledWindow() {
	return stubWindow('localhost');
}

function stubHostedWindow() {
	return stubWindow('sprocket.dev');
}

function stubWindow(hostname: string) {
	const localStorage = {
		getItem: vi.fn(),
		setItem: vi.fn(),
		removeItem: vi.fn()
	};
	const origin = hostname === 'localhost' ? 'http://localhost:17731' : `https://${hostname}`;
	const location = {
		hostname,
		origin,
		href: `${origin}/`,
		replace: vi.fn()
	};
	vi.stubGlobal('window', {
		location,
		localStorage,
		open: vi.fn(() => ({ opener: {} })),
		sprocketDesktopBridge: undefined
	});
	return { location, localStorage };
}

function mockAuthKitClient(currentUser: User | null) {
	return {
		getUser: vi.fn(() => currentUser),
		getAccessToken: vi.fn(async () => 'js-token'),
		signIn: vi.fn(async () => {}),
		signUp: vi.fn(async () => {}),
		signOut: vi.fn(async () => {}),
		getSignInUrl: vi.fn(async () => 'https://authkit.example/sign-in'),
		getSignUpUrl: vi.fn(async () => 'https://authkit.example/sign-up')
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}
