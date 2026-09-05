import { browser } from '$app/environment';
import { createClient, type User } from '@workos-inc/authkit-js';
import { z } from 'zod';
import { api } from '$convex/_generated/api';
import { usesLoopbackBrowserAuth } from '../../../desktop/local-config.mjs';
import { derived, get, writable } from 'svelte/store';

type AuthStatus = {
	isLoading: boolean;
	isReady: boolean;
	isConfigured: boolean;
	isWaitingForBrowserSignIn: boolean;
	browserSignInUrl: string | null;
	user: User | null;
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

type AuthClient = Awaited<ReturnType<typeof createClient>>;
type AuthBootstrapClient = {
	query: (
		query: typeof api.authBootstrap.getClientConfig,
		args: Record<string, never>
	) => Promise<{ workosClientId: string }>;
};

const DESKTOP_LOGIN_POLL_INTERVAL_MS = 1_500;
const DESKTOP_LOGIN_TIMEOUT_MS = 5 * 60 * 1_000;

let authClientPromise: Promise<AuthClient | null> | null = null;
let authConfigPromise: Promise<{ workosClientId: string }> | null = null;
let bootstrapClient: AuthBootstrapClient | null = null;
let isSigningOut = false;
type DesktopSignInAttempt = {
	abort: AbortController;
	loginId: string | null;
};
type AuthFlow = 'signIn' | 'signUp';
let desktopSignInAttempt: DesktopSignInAttempt | null = null;
let desktopLoginStartQueue: Promise<void> = Promise.resolve();

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
	if (!browser) {
		return null;
	}

	const bridge = window.sprocketDesktopBridge;
	if (!bridge?.getLocalBootstrap || !bridge.openExternal || !bridge.focusWindow) {
		return null;
	}

	return bridge;
}

function isInstalledBrowserApp() {
	return browser && usesLoopbackBrowserAuth(window.location.hostname, false);
}

async function getAuthClient() {
	if (!browser) {
		return null;
	}

	if (authClientPromise) {
		return await authClientPromise;
	}

	authClientPromise = (async () => {
		const clientId = await getClientId();
		if (!clientId) {
			authState.set({
				isLoading: false,
				isReady: true,
				isConfigured: false,
				isWaitingForBrowserSignIn: false,
				browserSignInUrl: null,
				user: null,
				nativeSession: 'notRequired',
				error: null
			});
			return null;
		}

		let client: AuthClient | null = null;

		try {
			client = await createClient(clientId, {
				redirectUri: `${window.location.origin}/callback`,
				onRedirectCallback: () => {
					window.location.replace('/');
				},
				onRefresh: () => {
					authState.update((current) => ({
						...current,
						user: client?.getUser() ?? null,
						error: null
					}));
				},
				onRefreshFailure: () => {
					authState.update((current) => ({
						...current,
						user: null,
						error: current.user && !isSigningOut ? 'Session refresh failed. Sign in again.' : null
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
				user,
				nativeSession: isInstalledBrowserApp() && user ? 'loading' : 'notRequired',
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
	authState.set({
		...get(authState),
		isLoading: true
	});

	try {
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
				user,
				nativeSession: isInstalledBrowserApp() && user ? 'loading' : 'notRequired',
				error: null
			};
		});
		if (isInstalledBrowserApp() && user) {
			await reconcileNativeSession(user.id);
		} else if (isInstalledBrowserApp()) {
			await clearNativeSession().catch(() => {});
		}
	} catch (error) {
		authState.update((current) => ({
			...current,
			isLoading: false,
			isReady: true,
			isWaitingForBrowserSignIn: false,
			browserSignInUrl: null,
			user: null,
			nativeSession: 'notRequired',
			error: error instanceof Error ? error.message : 'Failed to initialize authentication.'
		}));
	}
}

const errorMessagePayloadSchema = z.object({ error: z.string().optional() });
const desktopLoginStartSchema = z.object({ authorizationUrl: z.url(), loginId: z.string() });
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

async function fetchNativeSessionStatus() {
	const response = await fetch('/api/auth/native-session', { credentials: 'include' });
	if (!response.ok) {
		throw new Error(
			await errorMessageFromFailedResponse(response, 'Failed to check native sign-in.')
		);
	}
	const payload = desktopLoginResultSchema.safeParse(await response.json());
	if (!payload.success) {
		throw new Error('Local server returned an invalid native sign-in status.');
	}
	return payload.data;
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

async function reconcileNativeSession(browserUserId: string) {
	try {
		const result = await fetchNativeSessionStatus();
		if (result.status === 'authenticated') {
			const matches = result.user.id === browserUserId;
			authState.update((current) => ({
				...current,
				nativeSession: matches ? 'ready' : 'mismatch',
				error: matches
					? null
					: 'The browser and native sessions use different accounts. Sign out, then sign in with the same account.'
			}));
			return;
		}
		authState.update((current) => ({
			...current,
			nativeSession: result.status === 'signedOut' ? 'missing' : 'unavailable',
			error:
				result.status === 'signedOut'
					? 'Finish setting up sign-in before starting an agent.'
					: result.status === 'unavailable' || result.status === 'failed'
						? result.error
						: 'Native sign-in is still pending.'
		}));
	} catch (error) {
		authState.update((current) => ({
			...current,
			nativeSession: 'unavailable',
			error: error instanceof Error ? error.message : 'Failed to check native sign-in.'
		}));
	}
}

export async function reconcileNativeAuthentication() {
	if (!isInstalledBrowserApp()) {
		return;
	}
	const user = get(authState).user;
	if (user) {
		await reconcileNativeSession(user.id);
	}
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

async function pollDesktopLoginResult(signal: AbortSignal): Promise<{ id: string; email: string }> {
	const startedAt = Date.now();

	while (!signal.aborted) {
		if (Date.now() - startedAt > DESKTOP_LOGIN_TIMEOUT_MS) {
			throw new Error('Sign-in timed out. Try again.');
		}

		const response = await fetch('/api/auth/desktop-login/result', {
			credentials: 'include',
			signal
		});

		if (!response.ok) {
			throw new Error(
				await errorMessageFromFailedResponse(response, 'Failed to check desktop sign-in status.')
			);
		}

		const payload = desktopLoginResultSchema.safeParse(await response.json());
		if (!payload.success) {
			throw new Error('Failed to check desktop sign-in status.');
		}
		const result = payload.data;

		if (result.status === 'failed') {
			throw new Error(result.error || 'Desktop sign-in failed.');
		}

		if (result.status === 'authenticated') {
			return result.user;
		}

		if (result.status === 'unavailable') {
			throw new Error(result.error);
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

async function authenticateWithLoopbackBrowser(flow: AuthFlow, browserUser: User | null) {
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
		if (browserUser) {
			if (nativeUser.id !== browserUser.id) {
				authState.update((current) => ({
					...current,
					isWaitingForBrowserSignIn: false,
					browserSignInUrl: null,
					nativeSession: 'mismatch',
					error:
						'The browser and native sessions use different accounts. Sign out, then sign in with the same account.'
				}));
				return;
			}
			authState.update((current) => ({
				...current,
				isWaitingForBrowserSignIn: false,
				browserSignInUrl: null,
				nativeSession: 'ready',
				error: null
			}));
			return;
		}

		const client = await getAuthClient();
		if (!client) {
			throw new Error('Browser authentication is not configured.');
		}
		const browserAuthorizeUrl =
			flow === 'signUp' ? await client.getSignUpUrl() : await client.getSignInUrl();
		requireCurrentDesktopSignIn(attempt);
		window.location.href = browserAuthorizeUrl;
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
	const client = await getAuthClient();
	if (!client) {
		return;
	}

	const clientId = await getClientId();
	if (!clientId) {
		return;
	}

	if (getDesktopBridge() || isInstalledBrowserApp()) {
		await authenticateWithLoopbackBrowser(flow, client.getUser());
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
	const client = await getAuthClient();
	if (!client) {
		return;
	}

	cancelDesktopSignIn();
	isSigningOut = true;
	authState.update((current) => ({ ...current, isLoading: true }));

	const errors: string[] = [];
	let browserSignOutFailed = false;
	try {
		if (getDesktopBridge() || isInstalledBrowserApp()) {
			try {
				await clearNativeSession();
			} catch (error) {
				errors.push(error instanceof Error ? error.message : 'Failed to clear native session.');
			}
		}
		try {
			await client.signOut({ navigate: false, returnTo: window.location.origin });
		} catch (error) {
			browserSignOutFailed = true;
			errors.push(error instanceof Error ? error.message : 'Failed to clear browser session.');
		}
		convexAuthRetryPending.set(false);
		authState.set({
			isLoading: false,
			isReady: true,
			isConfigured: true,
			isWaitingForBrowserSignIn: false,
			browserSignInUrl: null,
			user: browserSignOutFailed ? client.getUser() : null,
			nativeSession: errors.length === 0 ? 'notRequired' : 'unavailable',
			error: errors.length === 0 ? null : errors.join(' ')
		});
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
	authState.update((current) => ({ ...current, isLoading: true, error: null }));
	convexAuthRetryPending.set(true);

	try {
		const token = await getAccessToken({ forceRefreshToken: true });
		if (!token) {
			throw new Error('Your session has expired. Sign in again.');
		}
		// Bump version so setupAuth reinstalls auth; clear isLoading so provider
		// loading/auth can transition and Convex can confirm the fresh token.
		convexAuthRetryVersion.update((version) => version + 1);
		authState.update((current) => ({ ...current, isLoading: false, error: null }));
	} catch (error) {
		convexAuthRetryPending.set(false);
		authState.update((current) => ({
			...current,
			isLoading: false,
			error: error instanceof Error ? error.message : 'Failed to refresh authentication.'
		}));
	}
}
