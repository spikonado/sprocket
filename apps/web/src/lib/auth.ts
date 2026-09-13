import { createClient, type User } from '@workos-inc/authkit-js';
import { z } from 'zod';
import { api } from '$convex/_generated/api';
import { usesLoopbackBrowserAuth } from '../../../desktop/local-config.mjs';
import {
	ensureLocalSession,
	readDesktopBootstrap,
	resolveLocalApiBaseUrl,
	type LocalBootstrap
} from '$lib/local/client';
import { derived, get, writable } from 'svelte/store';

export type AuthUser = Pick<User, 'id' | 'email' | 'firstName' | 'lastName' | 'profilePictureUrl'>;

type AuthStatus = {
	isLoading: boolean;
	isReady: boolean;
	isConfigured: boolean;
	isWaitingForBrowserSignIn: boolean;
	browserSignInUrl: string | null;
	user: AuthUser | null;
	nativeSession: 'notRequired' | 'loading' | 'ready' | 'missing' | 'mismatch' | 'unavailable';
	error: string | null;
};

const initialState: AuthStatus = {
	isLoading: true,
	isReady: false,
	isConfigured: true,
	isWaitingForBrowserSignIn: false,
	browserSignInUrl: null,
	user: null,
	nativeSession: 'notRequired',
	error: null
};

export const authState = writable<AuthStatus>(initialState);
// Primitive stores suppress same-user refresh notifications before setupAuth's effect.
export const convexAuthUserId = derived(authState, (state) => state.user?.id ?? null);
export const convexAuthLoading = derived(authState, (state) => !state.isReady || state.isLoading);
export const convexAuthRetryVersion = writable(0);
/** UI-only: stays true until Convex confirms or rejects the post-retry token. */
export const convexAuthRetryPending = writable(false);

type AuthClient = Pick<
	Awaited<ReturnType<typeof createClient>>,
	'getUser' | 'getAccessToken' | 'signIn' | 'signUp' | 'signOut' | 'getSignInUrl' | 'getSignUpUrl'
>;
type AuthBootstrapClient = {
	query: (
		query: typeof api.authBootstrap.getClientConfig,
		args: Record<string, never>
	) => Promise<{ workosClientId: string }>;
};
type AuthFlow = 'signIn' | 'signUp';
type DesktopSignInAttempt = {
	abort: AbortController;
	loginId: string | null;
};
type NativeTokenOutcome =
	| { kind: 'session'; accessToken: string; user: AuthUser }
	| { kind: 'signedOut' }
	| { kind: 'transient'; error: string }
	| { kind: 'pairing'; error: string }
	| { kind: 'mismatch'; error: string }
	| { kind: 'error'; error: string }
	| { kind: 'stale' };

const DESKTOP_LOGIN_POLL_INTERVAL_MS = 1_500;
const DESKTOP_LOGIN_TIMEOUT_MS = 5 * 60 * 1_000;
const TRANSIENT_AUTH_ERROR = 'Native sign-in is temporarily unavailable. Try again.';
let convexRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
const ACCOUNT_BINDING_ERROR =
	'This device is signed in with a different account. Sign out, then sign in with the same account.';

export type AuthRuntime = {
	createAuthKitClient: (...args: Parameters<typeof createClient>) => Promise<AuthClient>;
	resolveLocalApiBaseUrl: () => string | null;
	readDesktopBootstrap: (baseUrl: string) => Promise<LocalBootstrap | null>;
	ensureLocalSession: (baseUrl: string, bootstrap?: LocalBootstrap | null) => Promise<void>;
};

const productionAuthRuntime: AuthRuntime = {
	createAuthKitClient: createClient,
	resolveLocalApiBaseUrl,
	readDesktopBootstrap,
	ensureLocalSession
};

let authRuntime: AuthRuntime = productionAuthRuntime;

export function setAuthRuntime(nextRuntime: AuthRuntime) {
	authRuntime = nextRuntime;
}

function currentWindow() {
	return globalThis.window ?? null;
}

let authClientPromise: Promise<AuthClient | null> | null = null;
let authConfigPromise: Promise<{ workosClientId: string }> | null = null;
let bootstrapClient: AuthBootstrapClient | null = null;
let isSigningOut = false;
let desktopSignInAttempt: DesktopSignInAttempt | null = null;
let desktopLoginStartQueue: Promise<void> = Promise.resolve();
let authGeneration = 0;
let nativeAuthEvents: EventSource | null = null;
let nativeTokenInflight: {
	generation: number;
	forceRefreshToken: boolean;
	promise: Promise<NativeTokenOutcome>;
} | null = null;

export function resetAuthRuntime() {
	nativeAuthEvents?.close();
	nativeAuthEvents = null;
	clearConvexRecovery();
	desktopSignInAttempt?.abort.abort();
	desktopSignInAttempt = null;
	desktopLoginStartQueue = Promise.resolve();
	authClientPromise = null;
	authConfigPromise = null;
	bootstrapClient = null;
	isSigningOut = false;
	authGeneration = 0;
	nativeTokenInflight = null;
	authRuntime = productionAuthRuntime;
	convexAuthRetryVersion.set(0);
	convexAuthRetryPending.set(false);
	authState.set(initialState);
}

const errorMessagePayloadSchema = z.object({ error: z.string().optional() });
const desktopLoginStartSchema = z.object({ authorizationUrl: z.url(), loginId: z.string() });
const nativeAuthUserSchema = z.object({
	id: z.string(),
	email: z.email(),
	firstName: z.string().nullable().optional(),
	lastName: z.string().nullable().optional(),
	profilePictureUrl: z.string().nullable().optional()
});
const nativeSessionTokenSchema = z
	.object({
		accessToken: z.string(),
		user: nativeAuthUserSchema
	})
	.nullable();
const desktopLoginResultSchema = z.discriminatedUnion('status', [
	z.object({ status: z.literal('signedOut') }),
	z.object({ status: z.literal('pending') }),
	z.object({
		status: z.literal('authenticated'),
		user: z.object({ id: z.string(), email: z.email() })
	}),
	z.object({ status: z.literal('unavailable'), error: z.string() }),
	z.object({ status: z.literal('failed'), error: z.string() })
]);

function toAuthUser(user: {
	id: string;
	email: string;
	firstName?: string | null;
	lastName?: string | null;
	profilePictureUrl?: string | null;
}): AuthUser {
	return {
		id: user.id,
		email: user.email,
		firstName: user.firstName ?? null,
		lastName: user.lastName ?? null,
		profilePictureUrl: user.profilePictureUrl ?? null
	};
}

function signedOutState(overrides: Partial<AuthStatus> = {}): AuthStatus {
	return {
		isLoading: false,
		isReady: true,
		isConfigured: true,
		isWaitingForBrowserSignIn: false,
		browserSignInUrl: null,
		user: null,
		nativeSession: 'notRequired',
		error: null,
		...overrides
	};
}

function isTransientHttpStatus(status: number) {
	return (
		status === 408 ||
		status === 429 ||
		status === 500 ||
		status === 502 ||
		status === 503 ||
		status === 504
	);
}

function isInstalledApp() {
	return Boolean(getDesktopBridge() || isInstalledBrowserApp());
}

function invalidateAuthGeneration() {
	clearConvexRecovery();
	authGeneration += 1;
	nativeTokenInflight = null;
}

function getAuthBootstrapClient() {
	if (bootstrapClient) {
		return bootstrapClient;
	}

	throw new Error('Auth bootstrap is not initialized.');
}

async function getAuthConfig() {
	if (authConfigPromise) {
		return await authConfigPromise;
	}

	authConfigPromise = getAuthBootstrapClient().query(api.authBootstrap.getClientConfig, {});

	try {
		return await authConfigPromise;
	} catch (error) {
		authConfigPromise = null;
		throw error;
	}
}

async function getClientId() {
	const config = await getAuthConfig();
	return config.workosClientId?.trim() || undefined;
}

function getDesktopBridge() {
	const appWindow = currentWindow();
	if (!appWindow) {
		return null;
	}

	const bridge = appWindow.sprocketDesktopBridge;
	if (!bridge?.getLocalBootstrap || !bridge.openExternal || !bridge.focusWindow) {
		return null;
	}

	return bridge;
}

function isInstalledBrowserApp() {
	const appWindow = currentWindow();
	if (!appWindow) {
		return false;
	}
	return usesLoopbackBrowserAuth(appWindow.location.hostname, false);
}

async function pairLocalSession() {
	const baseUrl = authRuntime.resolveLocalApiBaseUrl();
	if (!baseUrl) {
		throw new Error('Unable to resolve the Sprocket server URL.');
	}

	const bootstrap = await authRuntime.readDesktopBootstrap(baseUrl);
	await authRuntime.ensureLocalSession(baseUrl, bootstrap);
}

async function getAuthClient() {
	if (!currentWindow()) {
		return null;
	}

	if (authClientPromise) {
		return await authClientPromise;
	}

	authClientPromise = (async () => {
		const clientId = await getClientId();
		if (!clientId) {
			authState.set(signedOutState({ isConfigured: false }));
			return null;
		}

		let client: AuthClient | null = null;

		try {
			client = await authRuntime.createAuthKitClient(clientId, {
				redirectUri: `${currentWindow()?.location.origin}/callback`,
				onRedirectCallback: () => {
					window.location.replace('/');
				},
				onRefresh: () => {
					const sdkUser = client?.getUser() ?? null;
					authState.update((current) => ({
						...current,
						user: sdkUser ? toAuthUser(sdkUser) : null,
						error: null
					}));
				},
				onRefreshFailure: () => {
					// authkit-js already keeps the stored session on transient
					// refresh failures and clears it only for terminal ones.
					const sdkUser = client?.getUser() ?? null;
					authState.update((current) => ({
						...current,
						user: sdkUser ? toAuthUser(sdkUser) : null,
						error:
							current.user && !sdkUser && !isSigningOut
								? 'Session refresh failed. Sign in again.'
								: current.error
					}));
				}
			});

			const user = client.getUser();
			authState.set({
				isLoading: false,
				isReady: true,
				isConfigured: true,
				isWaitingForBrowserSignIn: false,
				browserSignInUrl: null,
				user: user ? toAuthUser(user) : null,
				nativeSession: get(authState).nativeSession,
				error: null
			});
			return client;
		} catch (error) {
			authClientPromise = null;
			throw error;
		}
	})();

	return await authClientPromise;
}

export async function initializeAuth(convexClient: AuthBootstrapClient) {
	bootstrapClient = convexClient;
	const generation = authGeneration;
	const previous = get(authState);
	authState.set({
		...previous,
		isLoading: true,
		nativeSession: isInstalledApp() && !previous.user ? 'loading' : previous.nativeSession
	});

	try {
		if (isInstalledApp()) {
			await pairLocalSession();
			if (generation !== authGeneration) {
				return;
			}
			await initializeInstalledAuth(generation);
			watchNativeAuthentication();
			return;
		}

		await initializeHostedAuth();
	} catch (error) {
		if (generation !== authGeneration) {
			return;
		}
		authState.update((current) => ({
			...current,
			isLoading: false,
			isReady: true,
			isWaitingForBrowserSignIn: false,
			browserSignInUrl: null,
			nativeSession: current.nativeSession === 'loading' ? 'unavailable' : current.nativeSession,
			error: error instanceof Error ? error.message : 'Failed to initialize authentication.'
		}));
	}
}

function watchNativeAuthentication() {
	if (nativeAuthEvents || !globalThis.EventSource) return;
	const events = new EventSource('/api/auth/changes');
	nativeAuthEvents = events;
	events.onmessage = () => {
		if (nativeAuthEvents !== events || isSigningOut) return;
		invalidateAuthGeneration();
		const generation = authGeneration;
		void initializeInstalledAuth(generation);
	};
}

async function initializeHostedAuth() {
	const client = await getAuthClient();
	const user = client?.getUser() ?? null;
	authState.update((current) => {
		if (!current.isConfigured) {
			return {
				...current,
				isLoading: false,
				isReady: true
			};
		}

		return {
			isLoading: false,
			isReady: true,
			isConfigured: true,
			isWaitingForBrowserSignIn: false,
			browserSignInUrl: null,
			user: user ? toAuthUser(user) : null,
			nativeSession: 'notRequired',
			error: null
		};
	});
}

async function initializeInstalledAuth(generation: number) {
	const outcome = await requestNativeSessionToken(false, generation);
	if (generation !== authGeneration) return;
	applyNativeInitializeOutcome(outcome);
}

function applyNativeInitializeOutcome(outcome: NativeTokenOutcome) {
	switch (outcome.kind) {
		case 'session':
			authState.set({
				isLoading: false,
				isReady: true,
				isConfigured: true,
				isWaitingForBrowserSignIn: false,
				browserSignInUrl: null,
				user: outcome.user,
				nativeSession: 'ready',
				error: null
			});
			return;
		case 'signedOut':
			authState.set(signedOutState());
			return;
		case 'transient':
			authState.update((current) => ({
				...current,
				isLoading: false,
				isReady: true,
				nativeSession: current.nativeSession === 'loading' ? 'unavailable' : current.nativeSession,
				error: current.nativeSession === 'loading' ? outcome.error : current.error
			}));
			return;
		case 'pairing':
			authState.update((current) => ({
				...current,
				isLoading: false,
				isReady: true,
				nativeSession: 'unavailable',
				error: outcome.error
			}));
			return;
		case 'mismatch':
			authState.update((current) => ({
				...current,
				isLoading: false,
				isReady: true,
				nativeSession: 'mismatch',
				error: outcome.error
			}));
			return;
		case 'stale':
			return;
		case 'error':
			authState.update((current) => ({
				...current,
				isLoading: false,
				isReady: true,
				nativeSession: current.nativeSession === 'loading' ? 'unavailable' : current.nativeSession,
				error: outcome.error
			}));
	}
}

async function clearNativeSession() {
	const response = await fetch('/api/auth/native-session', {
		method: 'DELETE',
		credentials: 'include'
	});
	if (!response.ok) {
		throw new Error(
			await errorMessageFromFailedResponse(response, 'Failed to clear native session.')
		);
	}
}

export async function reconcileNativeAuthentication() {
	if (!isInstalledApp()) {
		return;
	}
	const generation = authGeneration;
	const outcome = await requestNativeSessionToken(false, generation);
	if (generation !== authGeneration) return;
	applyNativeInitializeOutcome(outcome);
}

async function requestNativeSessionToken(
	forceRefreshToken: boolean,
	generation: number
): Promise<NativeTokenOutcome> {
	if (generation !== authGeneration) {
		return { kind: 'stale' };
	}

	const inflight = nativeTokenInflight;
	if (inflight && inflight.generation === generation) {
		const shared = await inflight.promise;
		if (generation !== authGeneration) {
			return { kind: 'stale' };
		}
		if (!forceRefreshToken || inflight.forceRefreshToken) {
			return shared;
		}
	}

	const promise = fetchNativeSessionToken(forceRefreshToken);
	nativeTokenInflight = { generation, forceRefreshToken, promise };
	try {
		const outcome = await promise;
		if (generation !== authGeneration) {
			return { kind: 'stale' };
		}
		return outcome;
	} finally {
		if (nativeTokenInflight?.promise === promise) {
			nativeTokenInflight = null;
		}
	}
}

async function fetchNativeSessionToken(forceRefreshToken: boolean): Promise<NativeTokenOutcome> {
	let response: Response;
	try {
		response = await fetch('/api/auth/native-session/token', {
			method: 'POST',
			credentials: 'include',
			signal: AbortSignal.timeout(30_000),
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ forceRefreshToken })
		});
	} catch (error) {
		return {
			kind: 'transient',
			error: error instanceof Error ? error.message : TRANSIENT_AUTH_ERROR
		};
	}

	if (response.status === 401) {
		return {
			kind: 'pairing',
			error: await errorMessageFromFailedResponse(
				response,
				'Pair with your Sprocket server to continue.'
			)
		};
	}
	if (response.status === 409) {
		return {
			kind: 'mismatch',
			error: await errorMessageFromFailedResponse(response, ACCOUNT_BINDING_ERROR)
		};
	}
	if (isTransientHttpStatus(response.status)) {
		return {
			kind: 'transient',
			error: await errorMessageFromFailedResponse(response, TRANSIENT_AUTH_ERROR)
		};
	}
	if (!response.ok) {
		return {
			kind: 'error',
			error: await errorMessageFromFailedResponse(response, 'Failed to read the native session.')
		};
	}

	const parsed = nativeSessionTokenSchema.safeParse(await response.json().catch(() => undefined));
	if (!parsed.success) {
		return { kind: 'error', error: 'Local server returned an invalid native session.' };
	}
	if (parsed.data === null) {
		return { kind: 'signedOut' };
	}
	return {
		kind: 'session',
		accessToken: parsed.data.accessToken,
		user: toAuthUser(parsed.data.user)
	};
}

async function errorMessageFromFailedResponse(
	response: Response,
	fallback: string
): Promise<string> {
	const parsed = errorMessagePayloadSchema.safeParse(await response.json().catch(() => null));
	return parsed.success ? (parsed.data.error ?? fallback) : fallback;
}

async function startDesktopLogin(
	flow: AuthFlow
): Promise<{ authorizationUrl: string; loginId: string }> {
	const response = await fetch('/api/auth/desktop-login/start', {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ flow })
	});

	if (!response.ok) {
		throw new Error(
			await errorMessageFromFailedResponse(response, 'Failed to start desktop sign-in.')
		);
	}
	const payload = desktopLoginStartSchema.safeParse(await response.json());
	if (!payload.success) {
		throw new Error('Local server returned an invalid desktop sign-in URL.');
	}
	return payload.data;
}

function isCurrentDesktopSignIn(attempt: DesktopSignInAttempt): boolean {
	return desktopSignInAttempt === attempt && !attempt.abort.signal.aborted;
}

function requireCurrentDesktopSignIn(attempt: DesktopSignInAttempt): void {
	if (!isCurrentDesktopSignIn(attempt)) {
		throw new DOMException('Aborted', 'AbortError');
	}
}

async function startDesktopLoginInOrder(
	attempt: DesktopSignInAttempt,
	flow: AuthFlow
): Promise<string> {
	const previousStart = desktopLoginStartQueue;
	let releaseStart!: () => void;
	desktopLoginStartQueue = new Promise<void>((resolve) => {
		releaseStart = resolve;
	});

	await previousStart;
	try {
		requireCurrentDesktopSignIn(attempt);

		// Do not abort this request: a client-side abort does not prove the server
		// stopped processing it. Serializing complete responses guarantees that a
		// replacement attempt is the last /start request handled by the server.
		const { authorizationUrl, loginId } = await startDesktopLogin(flow);
		attempt.loginId = loginId;
		requireCurrentDesktopSignIn(attempt);
		return authorizationUrl;
	} finally {
		releaseStart();
	}
}

async function fetchDesktopLoginResult(signal: AbortSignal) {
	let response: Response;
	try {
		response = await fetch('/api/auth/desktop-login/result', {
			credentials: 'include',
			signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)])
		});
	} catch (error) {
		if (signal.aborted) throw error;
		return null;
	}
	if (isTransientHttpStatus(response.status)) return null;
	if (!response.ok) {
		throw new Error(
			await errorMessageFromFailedResponse(response, 'Failed to check desktop sign-in status.')
		);
	}
	return desktopLoginResultSchema.parse(await response.json());
}

async function pollDesktopLoginResult(signal: AbortSignal): Promise<{ id: string; email: string }> {
	const startedAt = Date.now();

	while (!signal.aborted) {
		if (Date.now() - startedAt > DESKTOP_LOGIN_TIMEOUT_MS) {
			throw new Error('Sign-in timed out. Try again.');
		}

		const result = await fetchDesktopLoginResult(signal);

		if (result?.status === 'failed') {
			throw new Error(result.error || 'Desktop sign-in failed.');
		}

		if (result?.status === 'authenticated') {
			return result.user;
		}

		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				signal.removeEventListener('abort', onAbort);
				resolve();
			}, DESKTOP_LOGIN_POLL_INTERVAL_MS);

			function onAbort() {
				clearTimeout(timeout);
				reject(new DOMException('Aborted', 'AbortError'));
			}

			signal.addEventListener('abort', onAbort, { once: true });
		});
	}

	throw new DOMException('Aborted', 'AbortError');
}

async function authenticateWithLoopbackBrowser(flow: AuthFlow) {
	const bridge = getDesktopBridge();
	if (!bridge && !isInstalledBrowserApp()) {
		throw new Error('Loopback browser sign-in is unavailable.');
	}

	stopDesktopSignInPolling();

	const attempt: DesktopSignInAttempt = {
		abort: new AbortController(),
		loginId: null
	};
	desktopSignInAttempt = attempt;

	authState.update((current) => ({
		...current,
		isWaitingForBrowserSignIn: true,
		browserSignInUrl: null,
		error: null
	}));

	try {
		const authorizeUrl = await startDesktopLoginInOrder(attempt, flow);
		requireCurrentDesktopSignIn(attempt);

		authState.update((current) => ({
			...current,
			browserSignInUrl: authorizeUrl
		}));
		requireCurrentDesktopSignIn(attempt);
		if (bridge) {
			void bridge.openExternal(authorizeUrl).catch((error) => {
				if (!isCurrentDesktopSignIn(attempt)) {
					return;
				}
				const detail = error instanceof Error ? error.message.trim() : '';
				authState.update((current) => ({
					...current,
					error: detail || 'Automatic browser open failed.'
				}));
			});
		} else {
			const opened = window.open(authorizeUrl, '_blank');
			if (opened) {
				try {
					opened.opener = null;
				} catch {
					// Best-effort isolation if the browser rejects opener writes.
				}
			} else {
				authState.update((current) => ({
					...current,
					error: 'Your browser blocked the sign-in window.'
				}));
			}
		}
		const nativeUser = await pollDesktopLoginResult(attempt.abort.signal);
		requireCurrentDesktopSignIn(attempt);
		if (bridge) {
			try {
				await bridge.focusWindow();
			} catch (error) {
				if (isCurrentDesktopSignIn(attempt)) {
					console.warn('Failed to focus desktop window after sign-in', error);
				}
			}
		}
		requireCurrentDesktopSignIn(attempt);
		await completeInstalledSignIn(attempt, nativeUser);
	} catch (error) {
		if (desktopSignInAttempt !== attempt) {
			return;
		}

		if (error instanceof DOMException && error.name === 'AbortError') {
			authState.update((current) => ({
				...current,
				isWaitingForBrowserSignIn: false,
				browserSignInUrl: null,
				error: null
			}));
			return;
		}

		authState.update((current) => ({
			...current,
			isWaitingForBrowserSignIn: false,
			browserSignInUrl: null,
			error: error instanceof Error ? error.message : 'Failed to sign in with the browser.'
		}));
	} finally {
		if (desktopSignInAttempt === attempt) {
			desktopSignInAttempt = null;
		}
	}
}

async function completeInstalledSignIn(
	attempt: DesktopSignInAttempt,
	nativeUser: { id: string; email: string }
) {
	invalidateAuthGeneration();
	const generation = authGeneration;
	const outcome = await requestNativeSessionToken(false, generation);
	requireCurrentDesktopSignIn(attempt);
	if (outcome.kind === 'stale') {
		return;
	}
	applyNativeLoginOutcome(outcome, toAuthUser(nativeUser));
}

function applyNativeLoginOutcome(outcome: NativeTokenOutcome, fallbackUser: AuthUser) {
	switch (outcome.kind) {
		case 'session':
			authState.set({
				isLoading: false,
				isReady: true,
				isConfigured: true,
				isWaitingForBrowserSignIn: false,
				browserSignInUrl: null,
				user: outcome.user,
				nativeSession: 'ready',
				error: null
			});
			return;
		case 'transient':
			authState.set({
				isLoading: false,
				isReady: true,
				isConfigured: true,
				isWaitingForBrowserSignIn: false,
				browserSignInUrl: null,
				user: fallbackUser,
				nativeSession: 'ready',
				error: null
			});
			return;
		case 'signedOut':
			authState.set(
				signedOutState({
					error: 'Native sign-in finished without a session. Try again.'
				})
			);
			return;
		case 'pairing':
			authState.update((current) => ({
				...current,
				isWaitingForBrowserSignIn: false,
				browserSignInUrl: null,
				nativeSession: 'unavailable',
				error: outcome.error
			}));
			return;
		case 'mismatch':
			authState.update((current) => ({
				...current,
				isWaitingForBrowserSignIn: false,
				browserSignInUrl: null,
				nativeSession: 'mismatch',
				error: outcome.error
			}));
			return;
		case 'error':
			authState.update((current) => ({
				...current,
				isWaitingForBrowserSignIn: false,
				browserSignInUrl: null,
				nativeSession: 'unavailable',
				error: outcome.error
			}));
			return;
		case 'stale':
			return;
	}
}

function stopDesktopSignInPolling() {
	desktopSignInAttempt?.abort.abort();
	desktopSignInAttempt = null;
}

export function cancelDesktopSignIn() {
	const cancelledAttempt = desktopSignInAttempt;
	const pendingStarts = desktopLoginStartQueue;
	stopDesktopSignInPolling();
	authState.update((current) => ({
		...current,
		isWaitingForBrowserSignIn: false,
		browserSignInUrl: null,
		error: null
	}));
	if (!cancelledAttempt) {
		return;
	}
	void pendingStarts
		.then(async () => {
			if (!cancelledAttempt.loginId) {
				return;
			}
			await fetch('/api/auth/desktop-login/cancel', {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ loginId: cancelledAttempt.loginId })
			});
		})
		.catch(() => {
			// Best-effort server cleanup; local UI already cancelled.
		});
}

/** Clears open-browser failure chrome while desktop sign-in polling continues. */
export function clearDesktopSignInOpenError() {
	authState.update((current) => {
		if (!current.isWaitingForBrowserSignIn || current.error === null) {
			return current;
		}
		return {
			...current,
			error: null
		};
	});
}

async function authenticate(flow: AuthFlow) {
	if (isInstalledApp()) {
		await authenticateWithLoopbackBrowser(flow);
		return;
	}

	const client = await getAuthClient();
	if (!client) {
		return;
	}

	const clientId = await getClientId();
	if (!clientId) {
		return;
	}

	if (flow === 'signUp') {
		await client.signUp();
		return;
	}

	await client.signIn();
}

export async function signIn() {
	await authenticate('signIn');
}

export async function signUp() {
	await authenticate('signUp');
}

export async function signOut() {
	cancelDesktopSignIn();
	isSigningOut = true;
	invalidateAuthGeneration();
	authState.update((current) => ({ ...current, isLoading: true }));

	const errors: string[] = [];
	let browserSignOutFailed = false;
	let remainingBrowserUser: AuthUser | null = null;
	try {
		if (isInstalledApp()) {
			try {
				await clearNativeSession();
			} catch (error) {
				errors.push(error instanceof Error ? error.message : 'Failed to clear native session.');
			}
		} else {
			const client = await getAuthClient();
			if (!client) {
				authState.set(signedOutState());
				return;
			}
			try {
				await client.signOut({ navigate: false, returnTo: window.location.origin });
			} catch (error) {
				browserSignOutFailed = true;
				const sdkUser = client.getUser();
				remainingBrowserUser = sdkUser ? toAuthUser(sdkUser) : null;
				errors.push(error instanceof Error ? error.message : 'Failed to clear browser session.');
			}
		}
		convexAuthRetryPending.set(false);
		authState.set(
			signedOutState({
				user: browserSignOutFailed ? remainingBrowserUser : null,
				nativeSession: errors.length === 0 ? 'notRequired' : 'unavailable',
				error: errors.length === 0 ? null : errors.join(' ')
			})
		);
	} catch (error) {
		authState.update((current) => ({
			...current,
			isLoading: false,
			error: error instanceof Error ? error.message : 'Failed to sign out.'
		}));
	} finally {
		isSigningOut = false;
	}
}

export async function getAccessToken({
	forceRefreshToken = false
}: { forceRefreshToken?: boolean } = {}) {
	if (isInstalledApp()) {
		const generation = authGeneration;
		const outcome = await requestNativeSessionToken(forceRefreshToken, generation);
		if (generation !== authGeneration || outcome.kind === 'stale') {
			return null;
		}
		return applyNativeAccessTokenOutcome(outcome, generation);
	}

	return await getAuthKitAccessToken({ forceRefreshToken });
}

function clearConvexRecovery() {
	if (convexRecoveryTimer !== null) {
		clearTimeout(convexRecoveryTimer);
		convexRecoveryTimer = null;
	}
}

export async function getConvexAccessToken(options: { forceRefreshToken: boolean }) {
	const generation = authGeneration;
	try {
		if (isInstalledApp() && get(authState).nativeSession === 'unavailable') {
			await pairLocalSession();
			if (generation !== authGeneration) return null;
		}
		const token = await getAccessToken(options);
		if (generation !== authGeneration) return null;
		clearConvexRecovery();
		return token;
	} catch (error) {
		if (generation !== authGeneration) return null;
		authState.update((current) => ({
			...current,
			error: error instanceof Error ? error.message : 'Session refresh is temporarily unavailable.'
		}));
		const state = get(authState);
		if (state.user && state.nativeSession !== 'mismatch' && convexRecoveryTimer === null) {
			convexRecoveryTimer = setTimeout(() => {
				convexRecoveryTimer = null;
				if (generation === authGeneration && get(authState).user) {
					convexAuthRetryVersion.update((version) => version + 1);
				}
			}, 5_000);
		}
		// Convex does not catch fetcher rejections, including while its socket is stopped.
		return null;
	}
}

function applyNativeAccessTokenOutcome(outcome: NativeTokenOutcome, generation: number) {
	if (generation !== authGeneration) {
		return null;
	}

	switch (outcome.kind) {
		case 'session':
			authState.update((current) => ({
				...current,
				user: outcome.user,
				nativeSession: 'ready',
				error: null
			}));
			return outcome.accessToken;
		case 'signedOut':
			authState.update((current) => ({
				...current,
				user: null,
				nativeSession: 'notRequired',
				error: null
			}));
			return null;
		case 'transient':
			throw new Error(outcome.error);
		case 'pairing':
			authState.update((current) => ({
				...current,
				nativeSession: 'unavailable',
				error: outcome.error
			}));
			throw new Error(outcome.error);
		case 'mismatch':
			authState.update((current) => ({
				...current,
				nativeSession: 'mismatch',
				error: outcome.error
			}));
			throw new Error(outcome.error);
		case 'error':
			throw new Error(outcome.error);
		case 'stale':
			return null;
	}
}

async function getAuthKitAccessToken({ forceRefreshToken }: { forceRefreshToken: boolean }) {
	const client = await getAuthClient();
	if (!client) {
		return null;
	}

	try {
		return await client.getAccessToken({ forceRefresh: forceRefreshToken });
	} catch (error) {
		if (error instanceof Error && error.name === 'LoginRequiredError') {
			authState.update((current) => ({ ...current, user: null }));
			return null;
		}

		throw error;
	}
}

export type ConvexAuthRetryAdvance = {
	clearPending: boolean;
	sawLoadingDuringRetry: boolean;
};

export function advanceConvexAuthRetryPending(args: {
	retryPending: boolean;
	isAuthenticated: boolean;
	isLoading: boolean;
	sawLoadingDuringRetry: boolean;
}): ConvexAuthRetryAdvance {
	if (!args.retryPending) {
		return { clearPending: false, sawLoadingDuringRetry: false };
	}

	if (args.isAuthenticated) {
		return { clearPending: true, sawLoadingDuringRetry: args.sawLoadingDuringRetry };
	}

	if (args.isLoading) {
		return { clearPending: false, sawLoadingDuringRetry: true };
	}

	if (args.sawLoadingDuringRetry) {
		return { clearPending: true, sawLoadingDuringRetry: true };
	}

	return { clearPending: false, sawLoadingDuringRetry: false };
}

export async function retryConvexAuthentication() {
	const generation = authGeneration;
	authState.update((current) => ({ ...current, isLoading: true, error: null }));
	convexAuthRetryPending.set(true);

	try {
		if (isInstalledApp()) {
			await pairLocalSession();
			if (generation !== authGeneration) return;
		}
		const token = await getAccessToken({ forceRefreshToken: true });
		if (generation !== authGeneration) return;
		if (!token) {
			throw new Error('Your session has expired. Sign in again.');
		}
		// Bump version so setupAuth reinstalls auth; clear isLoading so provider
		// loading/auth can transition and Convex can confirm the fresh token.
		convexAuthRetryVersion.update((version) => version + 1);
		authState.update((current) => ({ ...current, isLoading: false, error: null }));
	} catch (error) {
		if (generation !== authGeneration) return;
		convexAuthRetryPending.set(false);
		authState.update((current) => ({
			...current,
			isLoading: false,
			error: error instanceof Error ? error.message : 'Failed to refresh authentication.'
		}));
	}
}
