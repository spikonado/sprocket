import { browser, dev } from '$app/environment';
import { createClient, type User } from '@workos-inc/authkit-js';
import { z } from 'zod';
import { api } from '$convex/_generated/api';
import { usesLoopbackBrowserAuth } from '../../../desktop/local-config.mjs';
import { get, writable } from 'svelte/store';

type AuthStatus = {
	isLoading: boolean;
	isReady: boolean;
	isConfigured: boolean;
	isWaitingForBrowserSignIn: boolean;
	browserSignInUrl: string | null;
	user: User | null;
	error: string | null;
};

const initialState: AuthStatus = {
	isLoading: true,
	isReady: false,
	isConfigured: true,
	isWaitingForBrowserSignIn: false,
	browserSignInUrl: null,
	user: null,
	error: null
};

export const authState = writable<AuthStatus>(initialState);
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
	nonce: string;
	abort: AbortController;
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
	return browser && usesLoopbackBrowserAuth(window.location.hostname, false, dev);
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

			authState.set({
				isLoading: false,
				isReady: true,
				isConfigured: true,
				isWaitingForBrowserSignIn: false,
				browserSignInUrl: null,
				user: client.getUser(),
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
				user: client?.getUser() ?? null,
				error: null
			};
		});
	} catch (error) {
		authState.update((current) => ({
			...current,
			isLoading: false,
			isReady: true,
			isWaitingForBrowserSignIn: false,
			browserSignInUrl: null,
			user: null,
			error: error instanceof Error ? error.message : 'Failed to initialize authentication.'
		}));
	}
}

const desktopNonceStateSchema = z.object({ nonce: z.string() });
const errorMessagePayloadSchema = z.object({ error: z.string().optional() });
const desktopLoginResultSchema = z.discriminatedUnion('status', [
	z.object({ status: z.literal('pending') }),
	z.object({ status: z.literal('complete'), code: z.string(), state: z.string() }),
	z.object({ status: z.literal('failed'), error: z.string() })
]);

function extractNonceFromState(state: string): string | null {
	try {
		const parsed = desktopNonceStateSchema.safeParse(JSON.parse(state));
		if (!parsed.success) {
			return null;
		}
		const nonce = parsed.data.nonce.trim();
		return nonce.length > 0 ? nonce : null;
	} catch {
		return state.trim() || null;
	}
}

async function errorMessageFromFailedResponse(
	response: Response,
	fallback: string
): Promise<string> {
	const parsed = errorMessagePayloadSchema.safeParse(await response.json().catch(() => null));
	return parsed.success ? (parsed.data.error ?? fallback) : fallback;
}

async function startDesktopLogin(nonce: string): Promise<void> {
	const response = await fetch('/api/auth/desktop-login/start', {
		method: 'POST',
		credentials: 'include',
		headers: {
			'content-type': 'application/json'
		},
		body: JSON.stringify({ state: nonce })
	});

	if (!response.ok) {
		throw new Error(
			await errorMessageFromFailedResponse(response, 'Failed to start desktop sign-in.')
		);
	}
}

function isCurrentDesktopSignIn(attempt: DesktopSignInAttempt): boolean {
	return desktopSignInAttempt === attempt && !attempt.abort.signal.aborted;
}

function requireCurrentDesktopSignIn(attempt: DesktopSignInAttempt): void {
	if (!isCurrentDesktopSignIn(attempt)) {
		throw new DOMException('Aborted', 'AbortError');
	}
}

async function startDesktopLoginInOrder(attempt: DesktopSignInAttempt): Promise<void> {
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
		await startDesktopLogin(attempt.nonce);
		requireCurrentDesktopSignIn(attempt);
	} finally {
		releaseStart();
	}
}

function resolveDesktopLoginCallbackUrl(bootstrap: {
	httpBaseUrl: string;
	desktopLoginCallbackUrl?: string;
}): string {
	const configured = bootstrap.desktopLoginCallbackUrl?.trim();
	if (configured) {
		return configured.replace(/\/$/, '');
	}

	let parsed: URL;
	try {
		parsed = new URL(bootstrap.httpBaseUrl);
	} catch {
		throw new Error('Local server bootstrap URL is invalid.');
	}

	const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
	return `http://127.0.0.1:${port}/api/auth/desktop-login/callback`;
}

async function pollDesktopLoginResult(
	nonce: string,
	signal: AbortSignal
): Promise<{ code: string; state: string }> {
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

		if (result.status === 'complete') {
			const returnedNonce = extractNonceFromState(result.state);
			if (returnedNonce !== nonce) {
				throw new Error('Desktop sign-in state mismatch.');
			}
			return { code: result.code, state: result.state };
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

async function authenticateWithLoopbackBrowser(clientId: string, flow: AuthFlow) {
	const bridge = getDesktopBridge();
	if (!bridge && !isInstalledBrowserApp()) {
		throw new Error('Loopback browser sign-in is unavailable.');
	}

	stopDesktopSignInPolling();

	const attempt: DesktopSignInAttempt = {
		nonce: crypto.randomUUID(),
		abort: new AbortController()
	};
	desktopSignInAttempt = attempt;

	authState.update((current) => ({
		...current,
		isWaitingForBrowserSignIn: true,
		browserSignInUrl: null,
		error: null
	}));

	try {
		const bootstrap = bridge
			? await bridge.getLocalBootstrap()
			: { httpBaseUrl: window.location.origin };
		requireCurrentDesktopSignIn(attempt);
		const redirectUri = resolveDesktopLoginCallbackUrl(bootstrap);

		await startDesktopLoginInOrder(attempt);
		requireCurrentDesktopSignIn(attempt);

		// Temporary client so AuthKit stores the PKCE verifier and builds an authorize URL
		// that returns to the local loopback callback instead of the in-app /callback route.
		// Do not dispose(): dispose() resets the shared AuthKit memory store used by the
		// main client. This temporary client has no refresh timer unless a session exists.
		const authorizeClient = await createClient(clientId, {
			redirectUri
		});
		requireCurrentDesktopSignIn(attempt);
		const authorizeOptions = { state: { nonce: attempt.nonce } };
		const authorizeUrl =
			flow === 'signUp'
				? await authorizeClient.getSignUpUrl(authorizeOptions)
				: await authorizeClient.getSignInUrl(authorizeOptions);
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
		const result = await pollDesktopLoginResult(attempt.nonce, attempt.abort.signal);
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

		const callbackUrl = new URL('/callback', window.location.origin);
		callbackUrl.searchParams.set('code', result.code);
		callbackUrl.searchParams.set('state', result.state);
		requireCurrentDesktopSignIn(attempt);
		window.location.href = callbackUrl.toString();
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
			await fetch('/api/auth/desktop-login/cancel', {
				method: 'POST',
				credentials: 'include',
				headers: {
					'content-type': 'application/json'
				},
				body: JSON.stringify({ state: cancelledAttempt.nonce })
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
		await authenticateWithLoopbackBrowser(clientId, flow);
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

	try {
		await client.signOut({
			navigate: false,
			returnTo: window.location.origin
		});
		convexAuthRetryPending.set(false);
		authState.set({
			isLoading: false,
			isReady: true,
			isConfigured: true,
			isWaitingForBrowserSignIn: false,
			browserSignInUrl: null,
			user: null,
			error: null
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
