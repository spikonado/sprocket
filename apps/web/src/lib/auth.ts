import { browser } from '$app/environment';
import { createClient, type LoginRequiredError, type User } from '@workos-inc/authkit-js';
import { api } from '$convex/_generated/api';
import { get, writable } from 'svelte/store';

type AuthStatus = {
	isLoading: boolean;
	isReady: boolean;
	isWaitingForBrowserSignIn: boolean;
	browserSignInUrl: string | null;
	user: User | null;
	error: string | null;
};

const initialState: AuthStatus = {
	isLoading: true,
	isReady: false,
	isWaitingForBrowserSignIn: false,
	browserSignInUrl: null,
	user: null,
	error: null
};

export const authState = writable<AuthStatus>(initialState);

type AuthClient = Awaited<ReturnType<typeof createClient>>;
type AuthBootstrapClient = {
	query: (
		query: typeof api.authBootstrap.getClientConfig,
		args: Record<string, never>
	) => Promise<{ workosClientId: string | null }>;
};

const DESKTOP_LOGIN_POLL_INTERVAL_MS = 1_500;
const DESKTOP_LOGIN_TIMEOUT_MS = 5 * 60 * 1_000;

let authClientPromise: Promise<AuthClient | null> | null = null;
let authConfigPromise: Promise<{ workosClientId: string | null }> | null = null;
let bootstrapClient: AuthBootstrapClient | null = null;
let isSigningOut = false;
type DesktopSignInAttempt = {
	nonce: string;
	abort: AbortController;
};
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
				isWaitingForBrowserSignIn: false,
				browserSignInUrl: null,
				user: null,
				error: 'Missing WORKOS_CLIENT_ID.'
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
		authState.set({
			isLoading: false,
			isReady: true,
			isWaitingForBrowserSignIn: false,
			browserSignInUrl: null,
			user: client?.getUser() ?? null,
			error: null
		});
	} catch (error) {
		authState.set({
			isLoading: false,
			isReady: true,
			isWaitingForBrowserSignIn: false,
			browserSignInUrl: null,
			user: null,
			error: error instanceof Error ? error.message : 'Failed to initialize authentication.'
		});
	}
}

function extractNonceFromState(state: string): string | null {
	try {
		const parsed = JSON.parse(state) as { nonce?: unknown };
		return typeof parsed.nonce === 'string' && parsed.nonce.trim().length > 0
			? parsed.nonce.trim()
			: null;
	} catch {
		return state.trim() || null;
	}
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
		const payload = (await response.json().catch(() => null)) as { error?: string } | null;
		throw new Error(payload?.error ?? 'Failed to start desktop sign-in.');
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
			const payload = (await response.json().catch(() => null)) as { error?: string } | null;
			throw new Error(payload?.error ?? 'Failed to check desktop sign-in status.');
		}

		const payload = (await response.json()) as
			| { status: 'pending' }
			| { status: 'complete'; code: string; state: string }
			| { status: 'failed'; error: string };

		if (payload.status === 'failed') {
			throw new Error(payload.error || 'Desktop sign-in failed.');
		}

		if (payload.status === 'complete') {
			const returnedNonce = extractNonceFromState(payload.state);
			if (returnedNonce !== nonce) {
				throw new Error('Desktop sign-in state mismatch.');
			}
			return { code: payload.code, state: payload.state };
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

async function signInWithSystemBrowser(clientId: string) {
	const bridge = getDesktopBridge();
	if (!bridge) {
		throw new Error('Desktop bridge is unavailable.');
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
		const bootstrap = await bridge.getLocalBootstrap();
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
		const authorizeUrl = await authorizeClient.getSignInUrl({ state: { nonce: attempt.nonce } });
		requireCurrentDesktopSignIn(attempt);

		authState.update((current) => ({
			...current,
			browserSignInUrl: authorizeUrl
		}));
		requireCurrentDesktopSignIn(attempt);
		void bridge.openExternal(authorizeUrl).catch((error) => {
			if (!isCurrentDesktopSignIn(attempt)) {
				return;
			}
			authState.update((current) => ({
				...current,
				error:
					error instanceof Error
						? `Could not open your browser automatically: ${error.message}`
						: 'Could not open your browser automatically. Use the link shown to continue.'
			}));
		});
		const result = await pollDesktopLoginResult(attempt.nonce, attempt.abort.signal);
		requireCurrentDesktopSignIn(attempt);
		try {
			await bridge.focusWindow();
		} catch (error) {
			if (isCurrentDesktopSignIn(attempt)) {
				console.warn('Failed to focus desktop window after sign-in', error);
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
			error: error instanceof Error ? error.message : 'Failed to sign in with the system browser.'
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
		browserSignInUrl: null
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

export async function signIn() {
	const client = await getAuthClient();
	if (!client) {
		return;
	}

	const clientId = await getClientId();
	if (!clientId) {
		return;
	}

	if (getDesktopBridge()) {
		await signInWithSystemBrowser(clientId);
		return;
	}

	await client.signIn();
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
		authState.set({
			isLoading: false,
			isReady: true,
			isWaitingForBrowserSignIn: false,
			browserSignInUrl: null,
			user: null,
			error: null
		});
	} catch (error) {
		authState.set({
			isLoading: false,
			isReady: true,
			isWaitingForBrowserSignIn: false,
			browserSignInUrl: null,
			user: null,
			error: error instanceof Error ? error.message : 'Failed to sign out.'
		});
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
		const maybeLoginRequired = error as LoginRequiredError | Error;
		if (maybeLoginRequired.name === 'LoginRequiredError') {
			authState.update((current) => ({ ...current, user: null }));
			return null;
		}

		throw error;
	}
}
