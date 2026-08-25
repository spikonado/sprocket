import type { DataModel, Id } from '$convex/_generated/dataModel';
import type { DesktopApi, ProjectAttachment } from '$lib/types/sprocket';
import type { TableNamesInDataModel } from 'convex/server';
import { z } from 'zod';

export type LocalBootstrap = {
	httpBaseUrl: string;
	desktopLoginCallbackUrl?: string;
	pairingCredential: string;
};

const errorPayloadSchema = z.object({ error: z.string().optional() });
const sessionSchema = z.object({ authenticated: z.boolean().optional() });
const localBootstrapSchema = z.object({
	httpBaseUrl: z.string(),
	desktopLoginCallbackUrl: z.string().optional(),
	pairingCredential: z.string()
});
const filesystemBrowseResultSchema = z.object({
	parentPath: z.string(),
	entries: z.array(z.object({ name: z.string(), fullPath: z.string() }))
});
const workspaceSkillsResultSchema = z.object({
	skills: z.array(z.object({ name: z.string(), description: z.string() })),
	warnings: z.array(z.string())
});
const workspacePathResolutionSchema = z.object({
	workspacePath: z.string(),
	displayName: z.string(),
	repositoryKey: z.string()
});
const projectAttachmentSchema = z.object({
	projectId: z.string(),
	workspacePath: z.string(),
	availability: z.enum(['available', 'unavailable']),
	lastValidatedAt: z.number(),
	lastUsedAt: z.number(),
	unavailableReason: z.string().optional()
});
const agentRunStartSchema = z.object({
	runId: z.string()
});

function asConvexId<TableName extends TableNamesInDataModel<DataModel>>(
	value: string
): Id<TableName> {
	// SAFETY: the local API returns Convex document ids; branding is compile-time only.
	return value as Id<TableName>;
}

function parseProjectAttachment(
	attachment: z.infer<typeof projectAttachmentSchema>
): ProjectAttachment {
	return {
		...attachment,
		projectId: asConvexId(attachment.projectId)
	};
}

export function resolveLocalApiBaseUrl(): string | null {
	const configured = import.meta.env.VITE_LOCAL_API_URL?.trim();
	if (configured) {
		return configured.replace(/\/$/, '');
	}

	if (globalThis.window) {
		return globalThis.window.location.origin;
	}

	return null;
}

function readLaunchHashParameter(name: string): string | null {
	if (!globalThis.window) {
		return null;
	}

	const hash = globalThis.window.location.hash.startsWith('#')
		? globalThis.window.location.hash.slice(1)
		: globalThis.window.location.hash;

	return new URLSearchParams(hash).get(name);
}

export function readPairingTokenFromHash(): string | null {
	return readLaunchHashParameter('token');
}

export function readWorkspaceLaunchFromHash(): string | null {
	return readLaunchHashParameter('workspace');
}

export function workspaceLaunchHash(workspacePath: string): `#${string}` {
	return `#${new URLSearchParams({ workspace: workspacePath }).toString()}`;
}

export function clearLaunchHash() {
	if (!globalThis.window) {
		return;
	}

	const url = new URL(globalThis.window.location.href);
	url.hash = '';
	globalThis.window.history.replaceState(null, '', `${url.pathname}${url.search}`);
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
		const payload = errorPayloadSchema.safeParse(await response.json().catch(() => null));
		throw new Error(
			payload.success
				? (payload.data.error ?? 'Failed to authenticate with the Sprocket server.')
				: 'Failed to authenticate with the Sprocket server.'
		);
	}
}

export async function hasLocalSession(baseUrl: string): Promise<boolean> {
	const sessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
		credentials: 'include'
	});

	if (!sessionResponse.ok) {
		return false;
	}

	const session = sessionSchema.safeParse(await sessionResponse.json());
	return session.success ? Boolean(session.data.authenticated) : false;
}

export async function ensureLocalSession(baseUrl: string, bootstrap?: LocalBootstrap | null) {
	if (await hasLocalSession(baseUrl)) {
		return;
	}

	const hashToken = readPairingTokenFromHash();
	if (hashToken) {
		await bootstrapLocalSession(baseUrl, hashToken);
		clearLaunchHash();
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

		const parsed = localBootstrapSchema.safeParse(await response.json());
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

export async function readDesktopBootstrap(baseUrl: string): Promise<LocalBootstrap | null> {
	if (globalThis.window?.sprocketDesktopBridge?.getLocalBootstrap) {
		return await globalThis.window.sprocketDesktopBridge.getLocalBootstrap();
	}

	return await fetchLocalBootstrap(baseUrl);
}

async function parseJsonResponse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
	const contentType = response.headers.get('content-type') ?? '';
	const body = await response.text();

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

	const parsed = schema.safeParse(JSON.parse(body));
	if (!parsed.success) {
		throw new Error('Local API returned an unexpected response.');
	}
	return parsed.data;
}

export function createLocalClient(baseUrl: string): DesktopApi {
	async function request<T>(
		pathname: string,
		schema: z.ZodType<T>,
		init?: RequestInit
	): Promise<T> {
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
				const payload = await parseJsonResponse(response, errorPayloadSchema);
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
			throw new Error('Local API returned an empty response.');
		}

		return await parseJsonResponse(response, schema);
	}

	return {
		browseFilesystem: (input) => {
			const body = input.cwd
				? { partialPath: input.partialPath, cwd: input.cwd }
				: { partialPath: input.partialPath };
			return request('/api/workspace/browse', filesystemBrowseResultSchema, {
				method: 'POST',
				body: JSON.stringify(body)
			});
		},
		listWorkspaceSkills: (input) =>
			request('/api/workspace/skills', workspaceSkillsResultSchema, {
				method: 'POST',
				body: JSON.stringify({
					workspacePath: input.workspacePath
				})
			}),
		resolveWorkspacePath: (input) => {
			const body = input.createIfMissing
				? { workspacePath: input.workspacePath, createIfMissing: true }
				: { workspacePath: input.workspacePath };
			return request('/api/workspace/resolve', workspacePathResolutionSchema, {
				method: 'POST',
				body: JSON.stringify(body)
			});
		},
		listProjectAttachments: async () =>
			(await request('/api/workspace/projects', z.array(projectAttachmentSchema))).map(
				parseProjectAttachment
			),
		attachProject: async (attachment) =>
			parseProjectAttachment(
				await request('/api/workspace/projects', projectAttachmentSchema, {
					method: 'POST',
					body: JSON.stringify(attachment)
				})
			),
		runAgent: async (requestBody) => {
			const result = await request('/api/agent/run', agentRunStartSchema, {
				method: 'POST',
				body: JSON.stringify(requestBody)
			});
			return { runId: asConvexId(result.runId) };
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
