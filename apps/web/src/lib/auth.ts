import { browser } from '$app/environment';
import { createClient, type LoginRequiredError, type User } from '@workos-inc/authkit-js';
import { api } from '$convex/_generated/api';
import { get, writable } from 'svelte/store';

type AuthStatus = {
	isLoading: boolean;
	isReady: boolean;
	user: User | null;
	error: string | null;
};

const initialState: AuthStatus = {
	isLoading: true,
	isReady: false,
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

let authClientPromise: Promise<AuthClient | null> | null = null;
let authConfigPromise: Promise<{ workosClientId: string | null }> | null = null;
let bootstrapClient: AuthBootstrapClient | null = null;
let isSigningOut = false;

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
			user: client?.getUser() ?? null,
			error: null
		});
	} catch (error) {
		authState.set({
			isLoading: false,
			isReady: true,
			user: null,
			error: error instanceof Error ? error.message : 'Failed to initialize authentication.'
		});
	}
}

export async function signIn() {
	const client = await getAuthClient();
	if (!client) {
		return;
	}

	await client.signIn();
}

export async function signOut() {
	const client = await getAuthClient();
	if (!client) {
		return;
	}

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
			user: null,
			error: null
		});
	} catch (error) {
		authState.set({
			isLoading: false,
			isReady: true,
			user: null,
			error: error instanceof Error ? error.message : 'Failed to sign out.'
		});
	} finally {
		isSigningOut = false;
	}
}

export async function getAccessToken() {
	const client = await getAuthClient();
	if (!client) {
		return null;
	}

	try {
		return await client.getAccessToken();
	} catch (error) {
		const maybeLoginRequired = error as LoginRequiredError | Error;
		if (maybeLoginRequired.name === 'LoginRequiredError') {
			authState.update((current) => ({ ...current, user: null }));
			return null;
		}

		throw error;
	}
}
