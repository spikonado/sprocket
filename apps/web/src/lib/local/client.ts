import type {
	AgentAuthStatus,
	AgentRunStart,
	DesktopApi,
	FilesystemBrowseResult,
	WorkspaceOverview
} from '$lib/types/sprocket';

export type LocalBootstrap = {
	httpBaseUrl: string;
	desktopLoginCallbackUrl?: string;
	pairingCredential: string;
};

export function resolveLocalApiBaseUrl(): string | null {
	const configured = import.meta.env.VITE_LOCAL_API_URL?.trim();
	if (configured) {
		return configured.replace(/\/$/, '');
	}

	if (typeof window !== 'undefined') {
		return window.location.origin;
	}

	return null;
}

export function readPairingTokenFromHash(): string | null {
	if (typeof window === 'undefined') {
		return null;
	}

	const hash = window.location.hash.startsWith('#')
		? window.location.hash.slice(1)
		: window.location.hash;

	return new URLSearchParams(hash).get('token');
}

export function clearPairingTokenFromHash() {
	if (typeof window === 'undefined') {
		return;
	}

	const url = new URL(window.location.href);
	url.hash = '';
	window.history.replaceState(null, '', `${url.pathname}${url.search}`);
}

export async function bootstrapLocalSession(
	baseUrl: string,
	pairingCredential: string
): Promise<void> {
	const response = await fetch(`${baseUrl}/api/auth/bootstrap`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json'
		},
		credentials: 'include',
		body: JSON.stringify({ credential: pairingCredential })
	});

	if (!response.ok) {
		const payload = (await response.json().catch(() => null)) as { error?: string } | null;
		throw new Error(payload?.error ?? 'Failed to authenticate with the Sprocket server.');
	}
}

export async function hasLocalSession(baseUrl: string): Promise<boolean> {
	const sessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
		credentials: 'include'
	});

	if (!sessionResponse.ok) {
		return false;
	}

	const session = (await sessionResponse.json()) as { authenticated?: boolean };
	return Boolean(session.authenticated);
}

export async function ensureLocalSession(baseUrl: string, bootstrap?: LocalBootstrap | null) {
	if (await hasLocalSession(baseUrl)) {
		return;
	}

	const hashToken = readPairingTokenFromHash();
	if (hashToken) {
		await bootstrapLocalSession(baseUrl, hashToken);
		clearPairingTokenFromHash();
		return;
	}

	if (bootstrap?.pairingCredential) {
		await bootstrapLocalSession(baseUrl, bootstrap.pairingCredential);
		return;
	}

	const localBootstrap = await fetchLocalBootstrap(baseUrl);
	if (localBootstrap?.pairingCredential) {
		await bootstrapLocalSession(baseUrl, localBootstrap.pairingCredential);
		return;
	}

	throw new Error('Pair with your Sprocket server to continue.');
}

export async function fetchLocalBootstrap(baseUrl: string): Promise<LocalBootstrap | null> {
	try {
		const response = await fetch(`${baseUrl}/api/auth/desktop-bootstrap`);
		if (!response.ok) {
			return null;
		}

		return (await response.json()) as LocalBootstrap;
	} catch {
		return null;
	}
}

export async function readDesktopBootstrap(baseUrl: string): Promise<LocalBootstrap | null> {
	if (typeof window !== 'undefined' && window.sprocketDesktopBridge?.getLocalBootstrap) {
		return await window.sprocketDesktopBridge.getLocalBootstrap();
	}

	return await fetchLocalBootstrap(baseUrl);
}

async function readResponseBody(response: Response): Promise<string> {
	return await response.text();
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
	const contentType = response.headers.get('content-type') ?? '';
	const body = await readResponseBody(response);

	if (!contentType.includes('application/json')) {
		const preview = body.trim().slice(0, 120);
		if (preview.startsWith('<!')) {
			const baseUrl = resolveLocalApiBaseUrl();
			throw new Error(
				baseUrl
					? `The Sprocket API at ${baseUrl} returned a web page instead of JSON. Make sure the server is running correctly.`
					: 'The Sprocket API returned a web page instead of JSON. Make sure the server is running correctly.'
			);
		}

		throw new Error(
			preview.length > 0
				? `Local API returned an unexpected response: ${preview}`
				: 'Local API returned an empty response.'
		);
	}

	return JSON.parse(body) as T;
}

export function createLocalClient(baseUrl: string): DesktopApi {
	async function request<T>(pathname: string, init?: RequestInit): Promise<T> {
		const response = await fetch(`${baseUrl}${pathname}`, {
			...init,
			credentials: 'include',
			headers: {
				'content-type': 'application/json',
				...(init?.headers ?? {})
			}
		});

		if (!response.ok) {
			try {
				const payload = await parseJsonResponse<{ error?: string }>(response);
				throw new Error(payload.error ?? `Local request failed (${response.status}).`);
			} catch (error) {
				if (
					error instanceof Error &&
					error.message !== `Local request failed (${response.status}).`
				) {
					throw error;
				}

				throw new Error(`Local request failed (${response.status}).`, { cause: error });
			}
		}

		if (response.status === 204) {
			return undefined as T;
		}

		return await parseJsonResponse<T>(response);
	}

	return {
		browseFilesystem: (input) =>
			request<FilesystemBrowseResult>('/api/workspace/browse', {
				method: 'POST',
				body: JSON.stringify({
					partialPath: input.partialPath,
					...(input.cwd ? { cwd: input.cwd } : {})
				})
			}),
		workspaceOverviewForPath: (input) =>
			request<WorkspaceOverview>('/api/workspace/overview', {
				method: 'POST',
				body: JSON.stringify({
					workspacePath: input.workspacePath,
					...(input.createIfMissing ? { createIfMissing: true } : {})
				})
			}),
		listWorkspaceSessions: () => request('/api/workspace/sessions'),
		attachWorkspaceSession: (session) =>
			request('/api/workspace/sessions', {
				method: 'POST',
				body: JSON.stringify(session)
			}),
		getWorkspaceSessionOverview: (workspaceSessionId) =>
			request(`/api/workspace/sessions/${workspaceSessionId}`),
		runAgent: (requestBody) =>
			request<AgentRunStart>('/api/agent/run', {
				method: 'POST',
				body: JSON.stringify(requestBody)
			}),
		waitForAgentAuthRefresh: (authSessionId) =>
			request<AgentAuthStatus>(`/api/agent/auth/${encodeURIComponent(authSessionId)}`),
		refreshAgentAuth: async (authSessionId, authToken) => {
			await request(`/api/agent/auth/${encodeURIComponent(authSessionId)}`, {
				method: 'PUT',
				body: JSON.stringify({ authToken })
			});
		}
	};
}

export async function resolveDesktopApi(): Promise<DesktopApi> {
	const baseUrl = resolveLocalApiBaseUrl();
	if (!baseUrl) {
		throw new Error('Unable to resolve the Sprocket server URL.');
	}

	const bootstrap = await readDesktopBootstrap(baseUrl);
	await ensureLocalSession(baseUrl, bootstrap);
	return createLocalClient(baseUrl);
}
