import type { AssistantPart } from '@convex/lib/assistantParts';
import { convexId } from '$lib/convex-id';
import type { ArtifactsWatchEvent, LocalApi, ProjectAttachment } from '$lib/types/sprocket';
import { z } from 'zod';
import { localSocket } from './socket';
import { createLocalTransport } from './transport';

const errorPayloadSchema = z.object({ error: z.string().optional() });

// The server answers after the prompt is written, which can wait on a model call
// that writes a context handoff first.
const agentLaunchTimeoutMs = 10 * 60_000;

const sessionSchema = z.object({ authenticated: z.boolean().optional() });

const browserStatusSchema = z.object({
	state: z.enum(['installing', 'ready', 'error']),
	error: z.string().nullable()
});

const pullRequestStatesSchema = z.array(
	z.object({
		repository: z.string(),
		number: z.number(),
		state: z.enum(['open', 'closed', 'merged']),
		title: z.string()
	})
);

const filesystemBrowseResultSchema = z.object({
	parentPath: z.string(),
	entries: z.array(z.object({ name: z.string(), fullPath: z.string() })),
	volumeList: z.boolean().optional()
});

const workspaceSkillsResultSchema = z.object({
	skills: z.array(
		z.object({
			name: z.string(),
			description: z.string(),
			disableModelInvocation: z.boolean()
		})
	),
	warnings: z.array(z.string())
});

const workspaceSearchResultSchema = z.object({
	entries: z.array(z.object({ path: z.string(), kind: z.enum(['file', 'directory']) })),
	scanning: z.boolean()
});

const workspaceFilesResultSchema = z.object({
	paths: z.array(z.string()),
	gitStatus: z.array(
		z.object({
			path: z.string(),
			status: z.enum(['added', 'modified', 'deleted', 'renamed', 'untracked', 'ignored'])
		})
	),
	scanning: z.boolean(),
	truncated: z.boolean()
});

const workspaceFileContentSchema = z.object({
	content: z.string().nullable(),
	version: z.string(),
	size: z.number(),
	unsupported: z.enum(['binary', 'tooLarge']).nullable()
});

const diskErrorSchema = z.object({ kind: z.literal('error'), message: z.string() });

const workspaceFilesEventSchema = z.discriminatedUnion('kind', [
	workspaceFilesResultSchema.extend({ kind: z.literal('snapshot') }),
	diskErrorSchema
]);

const workspaceFileEventSchema = z.discriminatedUnion('kind', [
	workspaceFileContentSchema.extend({ kind: z.literal('snapshot') }),
	diskErrorSchema
]);

const workspaceFileWriteResultSchema = z.object({
	status: z.enum(['saved', 'conflict']),
	version: z.string()
});

const workspaceEntrySchema = z.object({ kind: z.enum(['file', 'directory']) });

const workspacePathResolutionSchema = z.object({
	workspacePath: z.string(),
	displayName: z.string(),
	repositoryKey: z.string(),
	attachmentKey: z.string()
});

const projectAttachmentSchema = z.object({
	workspacePath: z.string(),
	repositoryKey: z.string(),
	attachmentKey: z.string(),
	displayName: z.string(),
	availability: z.enum(['available', 'unavailable']),
	lastValidatedAt: z.int(),
	lastUsedAt: z.int(),
	lastMessageSentAt: z.int().optional(),
	unavailableReason: z.string().optional()
});

const runningCommandsSchema = z.array(
	z.object({
		sessionId: z.string(),
		command: z.string(),
		workdir: z.string(),
		startedAt: z.number()
	})
);

const agentRunStartSchema = z.object({
	runId: convexId<'runs'>(),
	threadId: convexId<'threadRecords'>(),
	stopped: z.boolean()
});

const localTranscriptAttachmentSchema = z.object({
	storageId: convexId<'_storage'>(),
	name: z.string(),
	mediaType: z.string(),
	size: z.int(),
	url: z.url().optional()
});

const transcriptUploadSuccessSchema = z.object({
	storageId: convexId<'_storage'>(),
	name: z.string(),
	mediaType: z.string(),
	size: z.number(),
	url: z.string()
});

const transcriptUploadResultSchema = z.union([
	transcriptUploadSuccessSchema,
	z.object({ error: z.string() })
]);

function transcriptUploadPath(args: { userId: string; name: string; threadId?: string }): string {
	let query = `userId=${encodeURIComponent(args.userId)}&name=${encodeURIComponent(args.name)}`;

	if (args.threadId) {
		query += `&threadId=${encodeURIComponent(args.threadId)}`;
	}

	return `/api/transcript/upload?${query}`;
}

const displayRowSchema = z.object({
	id: z.string(),
	threadId: convexId<'threadRecords'>(),
	runId: convexId<'runs'>(),
	sequence: z.int().nonnegative(),
	kind: z.enum(['prompt', 'text', 'work']),
	text: z.string().optional(),
	attachments: z.array(localTranscriptAttachmentSchema).optional(),
	toolCounts: z.record(z.string(), z.int().nonnegative()).optional(),
	unpersistedToolCallIds: z.array(z.string()).optional(),
	closed: z.boolean().optional(),
	revision: z.int().nonnegative()
});

const displayPageSchema = z.object({
	replicaId: z.string(),
	rows: z.array(displayRowSchema),
	indexing: z.boolean(),
	syncing: z.boolean(),
	stale: z.boolean(),
	nextBefore: z.int().nonnegative().optional(),
	revision: z.int().nonnegative(),
	persistedStreams: z.array(z.object({ runId: convexId<'runs'>(), streamId: z.string() })),
	changes: z.array(
		z.object({
			id: z.string(),
			row: displayRowSchema.nullable()
		})
	),
	changesCursor: z.object({ revision: z.int().nonnegative(), position: z.int().min(-1) }),
	moreChanges: z.boolean()
});

const assistantTimestampSchema = z.number().nullable().optional();

const assistantTextFieldsSchema = z.object({
	id: z.string(),
	text: z.string(),
	startedAt: assistantTimestampSchema,
	completedAt: assistantTimestampSchema,
	turnId: z.string().optional(),
	providerMetadata: z.json().optional()
});

const assistantPartSchema: z.ZodType<AssistantPart> = z.discriminatedUnion('type', [
	assistantTextFieldsSchema.extend({ type: z.literal('text') }),
	assistantTextFieldsSchema.extend({ type: z.literal('reasoning') }),
	z.object({
		type: z.literal('tool-call'),
		partId: z.string().optional(),
		callId: z.string(),
		name: z.string(),
		input: z.json(),
		turnId: z.string().optional(),
		startedAt: assistantTimestampSchema,
		completedAt: assistantTimestampSchema,
		providerMetadata: z.json().optional()
	}),
	z.object({
		type: z.literal('tool-result'),
		callId: z.string(),
		name: z.string().optional(),
		completedAt: assistantTimestampSchema,
		output: z.json()
	})
]);

const assistantPartsSchema = z.array(assistantPartSchema);

const displayDetailsSchema = z.object({
	parts: assistantPartsSchema,
	indexing: z.boolean(),
	nextAfter: z.int().nonnegative().optional(),
	previousBefore: z.int().nonnegative().optional(),
	revision: z.int().nonnegative(),
	stale: z.boolean()
});

const transcriptWatchEventSchema = z.object({
	eventType: z.string(),
	totalParts: z.int().optional(),
	stale: z.boolean()
});

const liveCompletionOverlaySchema = z.object({
	threadId: convexId<'threadRecords'>(),
	runId: convexId<'runs'>(),
	runStatus: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
	streamId: z.string().min(1),
	text: z.string(),
	parts: assistantPartsSchema
});

const liveCompletionWatchEventSchema = z.discriminatedUnion('eventType', [
	z.object({ eventType: z.literal('updated'), live: liveCompletionOverlaySchema }),
	z.object({ eventType: z.literal('cleared') })
]);

const localArtifactSchema = z.object({
	_id: z.string(),
	userId: z.string(),
	repositoryKey: z.string(),
	localPath: z.string().optional(),
	content: z.string(),
	title: z.string(),
	revision: z.number(),
	updatedAt: z.number(),
	localError: z.string().optional()
});

const artifactsWatchEventSchema = z.object({
	artifacts: z.array(localArtifactSchema),
	stale: z.boolean(),
	error: z.string().optional()
});

const chatGptStatusSchema = z.object({
	accounts: z.array(
		z.object({ connectionId: z.string(), label: z.string(), connected: z.boolean() })
	),
	activeConnectionId: z.string().nullable(),
	loginAvailable: z.boolean(),
	error: z.string().optional()
});

const chatGptBrowserLoginStartSchema = z.object({ state: z.string(), authorizeUrl: z.string() });

const gitHubStatusSchema = z.object({
	enabled: z.boolean(),
	cliVersion: z.string().nullable(),
	savedTokensProblem: z.string().nullable(),
	hosts: z.array(
		z.object({
			host: z.string(),
			enabled: z.boolean(),
			hasSavedToken: z.boolean(),
			source: z.enum(['settings', 'environment', 'gitHubCli']).nullable(),
			login: z.string().nullable(),
			problem: z.string().nullable()
		})
	)
});

const connectorStatusSchema = z.object({
	id: z.literal('kicad'),
	name: z.string(),
	state: z.enum(['notInstalled', 'installing', 'failed', 'installed']),
	error: z.string().nullable(),
	updateAvailable: z.boolean()
});

const chatGptBrowserLoginResultSchema = z.object({
	status: z.enum(['pending', 'complete', 'error']),
	error: z.string().optional()
});

const chatGptDisconnectSchema = z.object({ warning: z.string().nullable() });

function parseProjectAttachment(
	attachment: z.infer<typeof projectAttachmentSchema>
): ProjectAttachment {
	return attachment;
}

function parseArtifactsWatchEvent(
	event: z.infer<typeof artifactsWatchEventSchema>
): ArtifactsWatchEvent {
	return {
		artifacts: event.artifacts,
		stale: event.stale,
		error: event.error
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

export async function bootstrapLocalSession(baseUrl: string): Promise<void> {
	const response = await fetch(`${baseUrl}/api/auth/bootstrap`, {
		method: 'POST',
		credentials: 'include'
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

const localSessionRequests = new Map<string, Promise<void>>();

export async function ensureLocalSession(baseUrl: string) {
	const pending = localSessionRequests.get(baseUrl);

	if (pending) {
		return await pending;
	}

	const request = establishLocalSession(baseUrl);
	localSessionRequests.set(baseUrl, request);

	try {
		await request;
	} finally {
		localSessionRequests.delete(baseUrl);
	}
}

async function establishLocalSession(baseUrl: string) {
	if (await hasLocalSession(baseUrl)) {
		return;
	}

	await bootstrapLocalSession(baseUrl);
}

export function createLocalClient(baseUrl: string): LocalApi {
	const transport = createLocalTransport(baseUrl);
	const { request } = transport;
	const socket = localSocket(baseUrl);

	return {
		startBrowser: (signal) =>
			request('/api/browser/start', browserStatusSchema, { method: 'POST', signal }),
		browserDashboardUrl: `${baseUrl}/api/browser/dashboard/`,
		watchBrowserStatus: (handlers) =>
			socket.subscribeOnce(
				{ kind: 'browserStatus' },
				browserStatusSchema,
				handlers.signal,
				handlers.onEvent
			),
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
		searchWorkspace: (input, signal) =>
			request('/api/workspace/search', workspaceSearchResultSchema, {
				method: 'POST',
				body: JSON.stringify(input),
				signal
			}),
		watchWorkspaceFiles: (input, handlers) =>
			socket.subscribeOnce(
				{ kind: 'workspaceFiles', params: input },
				workspaceFilesEventSchema,
				handlers.signal,
				handlers.onEvent
			),
		workspaceEntryKind: async (input, signal) => {
			const { kind } = await request('/api/workspace/entry', workspaceEntrySchema, {
				method: 'POST',
				body: JSON.stringify(input),
				signal
			});

			return kind;
		},
		watchWorkspaceFile: (input, handlers) =>
			socket.subscribeOnce(
				{ kind: 'workspaceFile', params: input },
				workspaceFileEventSchema,
				handlers.signal,
				handlers.onEvent
			),
		readWorkspaceText: async (input, signal) => {
			const response = await transport.response('/api/workspace/file/text', {
				method: 'POST',
				body: JSON.stringify(input),
				signal
			});

			return {
				content: await response.text(),
				version: response.headers.get('x-file-version') ?? ''
			};
		},
		exportBoard3d: async (input, signal) => {
			const response = await transport.response('/api/workspace/file/board-3d', {
				method: 'POST',
				body: JSON.stringify(input),
				signal
			});

			return response.arrayBuffer();
		},
		writeWorkspaceFile: (input) =>
			request('/api/workspace/file/write', workspaceFileWriteResultSchema, {
				method: 'POST',
				body: JSON.stringify(input)
			}),
		createWorkspaceFile: async (input) => {
			await request('/api/workspace/file/create', z.unknown(), {
				method: 'POST',
				body: JSON.stringify(input)
			});
		},
		renameWorkspaceFile: async (input) => {
			await request('/api/workspace/file/rename', z.unknown(), {
				method: 'POST',
				body: JSON.stringify(input)
			});
		},
		deleteWorkspaceFile: async (input) => {
			await request('/api/workspace/file/delete', z.unknown(), {
				method: 'POST',
				body: JSON.stringify(input)
			});
		},
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
		removeProject: async (input) => {
			await request('/api/workspace/projects', z.null(), {
				method: 'DELETE',
				body: JSON.stringify(input)
			});
		},
		watchRunningCommands: (requestBody, handlers) =>
			socket.subscribe({ kind: 'commands', params: requestBody }, runningCommandsSchema, handlers),
		terminateCommand: (input) =>
			request('/api/agent/commands/terminate', z.object({ terminated: z.boolean() }), {
				method: 'POST',
				body: JSON.stringify(input)
			}),
		runAgent: async (requestBody) => {
			try {
				return await request('/api/agent/run', agentRunStartSchema, {
					method: 'POST',
					body: JSON.stringify(requestBody),
					signal: AbortSignal.timeout(agentLaunchTimeoutMs)
				});
			} catch (error) {
				if (error instanceof DOMException && error.name === 'TimeoutError') {
					throw new Error('The local server did not start the agent in time. Try again.', {
						cause: error
					});
				}

				throw error;
			}
		},
		fetchTranscriptDisplay: async (requestBody, signal) =>
			await request('/api/transcript/display', displayPageSchema, {
				method: 'POST',
				body: JSON.stringify(requestBody),
				signal
			}),
		fetchTranscriptDisplayDetails: async (requestBody, signal) => {
			return await request('/api/transcript/display-details', displayDetailsSchema, {
				method: 'POST',
				body: JSON.stringify(requestBody),
				signal
			});
		},
		watchTranscript: (requestBody, handlers) =>
			socket.subscribeOnce(
				{ kind: 'transcript', params: requestBody },
				transcriptWatchEventSchema.nullable().catch(null),
				handlers.signal,
				(event) => {
					if (event) handlers.onEvent(event);
				}
			),
		watchLiveCompletion: (requestBody, handlers) =>
			socket.subscribeOnce(
				{ kind: 'liveCompletion', params: requestBody },
				liveCompletionWatchEventSchema.nullable().catch(null),
				handlers.signal,
				(event) => {
					if (event) handlers.onEvent(event);
				}
			),
		clearTranscriptReplica: async (requestBody) => {
			await transport.response('/api/transcript/clear', {
				method: 'POST',
				body: JSON.stringify(requestBody)
			});
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
		uploadTranscriptAttachment: async (requestBody) =>
			await request(
				transcriptUploadPath({
					userId: requestBody.userId,
					name: requestBody.name,
					threadId: requestBody.threadId
				}),
				transcriptUploadResultSchema,
				{
					method: 'POST',
					headers: {
						'content-type': requestBody.file.type.trim() || 'application/octet-stream'
					},
					body: requestBody.file
				}
			),
		discardTranscriptAttachment: async (requestBody) =>
			await request('/api/transcript/discard', z.boolean(), {
				method: 'POST',
				body: JSON.stringify({
					userId: requestBody.userId,
					storageId: requestBody.storageId,
					threadId: requestBody.threadId
				})
			}),
		deleteArtifact: async (requestBody) => {
			await request('/api/artifacts/delete', z.null(), {
				method: 'POST',
				body: JSON.stringify(requestBody)
			});
		},
		watchArtifacts: (requestBody, handlers) =>
			socket.subscribe({ kind: 'artifacts', params: requestBody }, artifactsWatchEventSchema, {
				...handlers,
				onEvent: (event) => {
					handlers.onEvent(parseArtifactsWatchEvent(event));
				}
			}),
		requestRunCancellation: async (requestBody) => {
			await request('/api/threads/cancel', z.boolean(), {
				method: 'POST',
				body: JSON.stringify(requestBody)
			});
		},
		fetchPullRequestStates: async (requestBody) =>
			await request('/api/pull-requests/states', pullRequestStatesSchema, {
				method: 'POST',
				body: JSON.stringify(requestBody)
			}),
		startAccountSession: async (requestBody) => {
			await request('/api/threads/account-session/start', z.null(), {
				method: 'POST',
				body: JSON.stringify(requestBody)
			});
		},
		endAccountSession: async (requestBody) => {
			await request('/api/threads/account-session/end', z.null(), {
				method: 'POST',
				body: JSON.stringify(requestBody)
			});
		},
		fetchChatGptStatus: async (requestBody) =>
			await request('/api/chatgpt/status', chatGptStatusSchema, {
				method: 'POST',
				body: JSON.stringify(requestBody)
			}),
		startChatGptBrowserLogin: async (requestBody) =>
			await request('/api/chatgpt/browser/start', chatGptBrowserLoginStartSchema, {
				method: 'POST',
				body: JSON.stringify(requestBody)
			}),
		fetchChatGptBrowserLoginResult: async (requestBody) =>
			await request('/api/chatgpt/browser/result', chatGptBrowserLoginResultSchema, {
				method: 'POST',
				body: JSON.stringify(requestBody)
			}),
		cancelChatGptBrowserLogin: async (requestBody) => {
			await request('/api/chatgpt/browser/cancel', z.null(), {
				method: 'POST',
				body: JSON.stringify(requestBody)
			});
		},
		selectChatGptAccount: async (requestBody) => {
			await request('/api/chatgpt/select', z.null(), {
				method: 'POST',
				body: JSON.stringify(requestBody)
			});
		},
		disconnectChatGptAccount: async (requestBody) => {
			const { warning } = await request('/api/chatgpt/disconnect', chatGptDisconnectSchema, {
				method: 'POST',
				body: JSON.stringify(requestBody)
			});

			return warning;
		},
		fetchGitHubStatus: async (userId) =>
			await request(
				`/api/github/status?${new URLSearchParams({ userId }).toString()}`,
				gitHubStatusSchema
			),
		updateGitHubSettings: async (userId, update) =>
			await request('/api/github/settings', gitHubStatusSchema, {
				method: 'POST',
				body: JSON.stringify({ userId, ...update })
			}),
		fetchConnectors: async (userId) =>
			await request(
				`/api/connectors?${new URLSearchParams({ userId }).toString()}`,
				z.array(connectorStatusSchema)
			),
		installConnector: async (userId, id) =>
			await request(`/api/connectors/${id}/install`, connectorStatusSchema, {
				method: 'POST',
				body: JSON.stringify({ userId })
			}),
		uninstallConnector: async (userId, id) =>
			await request(`/api/connectors/${id}/uninstall`, connectorStatusSchema, {
				method: 'POST',
				body: JSON.stringify({ userId })
			})
	};
}

export async function resolveLocalApi(): Promise<LocalApi> {
	const baseUrl = resolveLocalApiBaseUrl();

	if (!baseUrl) {
		throw new Error('Unable to resolve the Sprocket server URL.');
	}

	await ensureLocalSession(baseUrl);

	return createLocalClient(baseUrl);
}
