import type { AssistantPart } from '$convex/lib/assistantParts';
import type { DataModel, Id } from '$convex/_generated/dataModel';
import type { JsonValue } from '$convex/lib/json';
import type {
	DesktopApi,
	LiveCompletionOverlay,
	LiveCompletionWatchEvent,
	LocalTranscriptPage,
	LocalTranscriptPart,
	ProjectAttachment,
	ThreadCacheSnapshot,
	ThreadCacheUserRequest,
	ThreadCacheWatchEvent,
	ThreadSummary,
	TranscriptScopeRequest
} from '$lib/types/sprocket';
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
	entries: z.array(z.object({ name: z.string(), fullPath: z.string() })),
	volumeList: z.boolean().optional()
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
	workspacePath: z.string(),
	repositoryKey: z.string(),
	displayName: z.string(),
	availability: z.enum(['available', 'unavailable']),
	lastValidatedAt: z.int(),
	lastUsedAt: z.int(),
	unavailableReason: z.string().optional(),
	previousRepositoryKey: z.string().optional()
});
const agentRunStartSchema = z.object({
	runId: z.string()
});
const localTranscriptAttachmentSchema = z.object({
	imageUploadId: z.string(),
	name: z.string(),
	mediaType: z.string(),
	size: z.int(),
	storageId: z.string(),
	url: z.string().optional()
});
const localTranscriptPartSchema = z.object({
	number: z.int(),
	sourceKey: z.string(),
	kind: z.enum(['prompt', 'completion', 'tool']),
	runId: z.string(),
	prompt: z
		.object({
			text: z.string(),
			imageUploads: z.array(localTranscriptAttachmentSchema)
		})
		.optional(),
	completion: z
		.object({
			streamId: z.string().optional(),
			items: z.array(z.unknown())
		})
		.optional(),
	tool: z
		.object({
			jobId: z.string().optional(),
			toolInvocationId: z.string().optional(),
			callId: z.string(),
			name: z.string(),
			output: z.unknown().optional(),
			status: z.enum(['started', 'completed', 'failed', 'cancelled'])
		})
		.optional()
});
const localTranscriptPageSchema = z.object({
	threadId: z.string(),
	totalParts: z.int(),
	historyFromNumber: z.int(),
	stale: z.boolean(),
	parts: z.array(localTranscriptPartSchema),
	nextBefore: z.int().optional()
});
const transcriptWatchEventSchema = z.object({
	eventType: z.string(),
	totalParts: z.int().optional(),
	stale: z.boolean()
});
const liveCompletionOverlaySchema = z.object({
	threadId: z.string(),
	runId: z.string(),
	runStatus: z.enum(['queued', 'running', 'awaiting_executor', 'completed', 'failed', 'cancelled']),
	streamId: z.string().optional(),
	text: z.string(),
	parts: z.array(z.unknown()),
	runStartedAt: z.int()
});
const liveCompletionWatchEventSchema = z.discriminatedUnion('eventType', [
	z.object({ eventType: z.literal('updated'), live: liveCompletionOverlaySchema }),
	z.object({ eventType: z.literal('cleared') })
]);
const threadSummarySchema = z.object({
	threadId: z.string(),
	repositoryKey: z.string(),
	title: z.string(),
	selectedModel: z.string(),
	reasoningEffort: z.string(),
	serviceTier: z.string(),
	lastMessageAt: z.int(),
	threadStatus: z.enum(['active', 'archived']),
	latestRunStatus: z
		.enum(['queued', 'running', 'awaiting_executor', 'completed', 'failed', 'cancelled'])
		.nullable()
		.optional(),
	latestRunId: z.string().nullable().optional(),
	latestRunStartedAt: z.int().nullable().optional(),
	latestRunClaimExpiresAt: z.int().nullable().optional(),
	hasActiveRun: z.boolean()
});
const threadCacheWatchEventSchema = z.object({
	status: z.enum(['loading', 'live', 'reconnecting', 'offline', 'error']),
	lastSyncedAt: z.int().nullable()
});
const threadCacheSnapshotSchema = threadCacheWatchEventSchema.extend({
	threads: z.array(threadSummarySchema)
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
	return attachment;
}

function parseLocalTranscriptPage(
	page: z.infer<typeof localTranscriptPageSchema>
): LocalTranscriptPage {
	return {
		threadId: asConvexId(page.threadId),
		totalParts: page.totalParts,
		historyFromNumber: page.historyFromNumber,
		stale: page.stale,
		nextBefore: page.nextBefore,
		parts: page.parts.map(parseLocalTranscriptPart)
	};
}

function parseLocalTranscriptTool(
	tool: NonNullable<z.infer<typeof localTranscriptPartSchema>['tool']>
): NonNullable<LocalTranscriptPart['tool']> {
	const parsed: NonNullable<LocalTranscriptPart['tool']> = {
		callId: tool.callId,
		name: tool.name,
		status: tool.status
	};
	if (tool.jobId) parsed.jobId = asConvexId(tool.jobId);
	if (tool.toolInvocationId) parsed.toolInvocationId = tool.toolInvocationId;
	if (tool.output !== undefined) {
		// SAFETY: JSONL replica tool output is Convex JSON.
		parsed.output = tool.output as JsonValue;
	}
	return parsed;
}

function parseLocalTranscriptPart(
	part: z.infer<typeof localTranscriptPartSchema>
): LocalTranscriptPart {
	return {
		number: part.number,
		sourceKey: part.sourceKey,
		kind: part.kind,
		runId: asConvexId(part.runId),
		prompt: part.prompt
			? {
					text: part.prompt.text,
					imageUploads: part.prompt.imageUploads.map((upload) => ({
						...upload,
						imageUploadId: asConvexId(upload.imageUploadId)
					}))
				}
			: undefined,
		completion: part.completion
			? {
					streamId: part.completion.streamId,
					// SAFETY: Convex completion items are assistant parts; the page API
					// already validated the surrounding replica payload.
					items: part.completion.items as AssistantPart[]
				}
			: undefined,
		tool: part.tool ? parseLocalTranscriptTool(part.tool) : undefined
	};
}

function parseLiveCompletionOverlay(
	live: z.infer<typeof liveCompletionOverlaySchema>
): LiveCompletionOverlay {
	return {
		threadId: asConvexId(live.threadId),
		runId: asConvexId(live.runId),
		runStatus: live.runStatus,
		streamId: live.streamId,
		text: live.text,
		// SAFETY: overlay parts match AssistantPart; the local SSE payload is produced by the hub.
		parts: live.parts as AssistantPart[],
		runStartedAt: live.runStartedAt
	};
}

function parseThreadSummary(thread: z.infer<typeof threadSummarySchema>): ThreadSummary {
	return {
		threadId: asConvexId(thread.threadId),
		repositoryKey: thread.repositoryKey,
		title: thread.title,
		selectedModel: thread.selectedModel,
		reasoningEffort: thread.reasoningEffort,
		serviceTier: thread.serviceTier,
		lastMessageAt: thread.lastMessageAt,
		threadStatus: thread.threadStatus,
		latestRunStatus: thread.latestRunStatus ?? null,
		latestRunId: thread.latestRunId ? asConvexId(thread.latestRunId) : null,
		latestRunStartedAt: thread.latestRunStartedAt ?? undefined,
		latestRunClaimExpiresAt: thread.latestRunClaimExpiresAt ?? undefined,
		hasActiveRun: thread.hasActiveRun
	};
}

function parseThreadCacheWatchEvent(
	event: z.infer<typeof threadCacheWatchEventSchema>
): ThreadCacheWatchEvent {
	return {
		status: event.status,
		lastSyncedAt: event.lastSyncedAt
	};
}

function parseThreadCacheSnapshot(
	snapshot: z.infer<typeof threadCacheSnapshotSchema>
): ThreadCacheSnapshot {
	return {
		...parseThreadCacheWatchEvent(snapshot),
		threads: snapshot.threads.map(parseThreadSummary)
	};
}

function parseLiveCompletionWatchEvent(
	event: z.infer<typeof liveCompletionWatchEventSchema>
): LiveCompletionWatchEvent {
	if (event.eventType === 'updated') {
		return { eventType: 'updated', live: parseLiveCompletionOverlay(event.live) };
	}
	return { eventType: 'cleared' };
}

async function readSseEvents(
	response: Response,
	signal: AbortSignal,
	onData: (data: string) => void
) {
	if (!response.body) {
		return;
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		while (!signal.aborted) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			let separator = buffer.indexOf('\n\n');
			while (separator >= 0) {
				const chunk = buffer.slice(0, separator);
				buffer = buffer.slice(separator + 2);
				const dataLines = chunk
					.split('\n')
					.filter((line) => line.startsWith('data:'))
					.map((line) => line.slice(5).trimStart());
				if (dataLines.length > 0 && !signal.aborted) {
					onData(dataLines.join('\n'));
				}
				separator = buffer.indexOf('\n\n');
			}
		}
	} catch (error) {
		if (signal.aborted) {
			return;
		}
		throw error;
	} finally {
		reader.releaseLock();
	}
}

function localRequestError(
	status: number,
	payload: z.infer<typeof errorPayloadSchema> | undefined
): Error {
	return new Error(payload?.error ?? `Local request failed (${status}).`);
}

async function errorFromFailedResponse(response: Response): Promise<Error> {
	const parsed = errorPayloadSchema.safeParse(await response.json().catch(() => null));
	return localRequestError(response.status, parsed.success ? parsed.data : undefined);
}

async function postSse(
	url: string,
	requestBody: TranscriptScopeRequest | ThreadCacheUserRequest,
	signal: AbortSignal,
	onData: (data: string) => void
) {
	const response = await fetch(url, {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(requestBody),
		signal
	});
	if (!response.ok) {
		throw await errorFromFailedResponse(response);
	}
	await readSseEvents(response, signal, onData);
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
				...init?.headers
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
		},
		fetchTranscriptPage: async (requestBody) => {
			const page = await request('/api/transcript/page', localTranscriptPageSchema, {
				method: 'POST',
				body: JSON.stringify(requestBody)
			});
			return parseLocalTranscriptPage(page);
		},
		watchTranscript: async (requestBody, handlers) => {
			await postSse(`${baseUrl}/api/transcript/watch`, requestBody, handlers.signal, (data) => {
				const parsed = transcriptWatchEventSchema.safeParse(JSON.parse(data));
				if (parsed.success) {
					handlers.onEvent(parsed.data);
				}
			});
		},
		watchLiveCompletion: async (requestBody, handlers) => {
			await postSse(`${baseUrl}/api/agent/live`, requestBody, handlers.signal, (data) => {
				const parsed = liveCompletionWatchEventSchema.safeParse(JSON.parse(data));
				if (parsed.success) {
					handlers.onEvent(parseLiveCompletionWatchEvent(parsed.data));
				}
			});
		},
		clearTranscriptReplica: async (requestBody) => {
			const response = await fetch(`${baseUrl}/api/transcript/clear`, {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(requestBody)
			});
			if (!response.ok) {
				throw await errorFromFailedResponse(response);
			}
		},
		fetchTranscriptAttachment: async (requestBody) => {
			const response = await fetch(`${baseUrl}/api/transcript/attachment`, {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(requestBody)
			});
			if (response.status === 404) {
				return null;
			}
			if (!response.ok) {
				return null;
			}
			return await response.blob();
		},
		registerThreadCache: async (requestBody) =>
			parseThreadCacheWatchEvent(
				await request('/api/threads/register', threadCacheWatchEventSchema, {
					method: 'POST',
					body: JSON.stringify(requestBody)
				})
			),
		fetchThreadSnapshot: async (requestBody) =>
			parseThreadCacheSnapshot(
				await request('/api/threads/snapshot', threadCacheSnapshotSchema, {
					method: 'POST',
					body: JSON.stringify(requestBody)
				})
			),
		syncArchivedThreads: async (requestBody) =>
			parseThreadCacheWatchEvent(
				await request('/api/threads/archive-sync', threadCacheWatchEventSchema, {
					method: 'POST',
					body: JSON.stringify(requestBody)
				})
			),
		watchThreadCache: async (requestBody, handlers) => {
			await postSse(`${baseUrl}/api/threads/watch`, requestBody, handlers.signal, (data) => {
				const parsed = threadCacheWatchEventSchema.safeParse(JSON.parse(data));
				if (parsed.success) {
					handlers.onEvent(parseThreadCacheWatchEvent(parsed.data));
				}
			});
		},
		renameThread: async (requestBody) =>
			await request('/api/threads/rename', z.boolean(), {
				method: 'POST',
				body: JSON.stringify(requestBody)
			}),
		archiveThread: async (requestBody) =>
			await request('/api/threads/archive', z.boolean(), {
				method: 'POST',
				body: JSON.stringify(requestBody)
			}),
		restoreThread: async (requestBody) =>
			await request('/api/threads/restore', z.boolean(), {
				method: 'POST',
				body: JSON.stringify(requestBody)
			}),
		rekeyRepository: async (requestBody) =>
			await request('/api/threads/rekey', z.int(), {
				method: 'POST',
				body: JSON.stringify(requestBody)
			}),
		requestRunCancellation: async (requestBody) => {
			await request('/api/threads/cancel', z.boolean(), {
				method: 'POST',
				body: JSON.stringify(requestBody)
			});
		},
		endAccountSession: async (requestBody) => {
			await request('/api/threads/account-session/end', z.null(), {
				method: 'POST',
				body: JSON.stringify(requestBody)
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
