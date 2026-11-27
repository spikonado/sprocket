import { convexId } from '$lib/convex-id';
import type {
	LocalApi,
	ProjectAttachment,
	SignInTarget,
	TranscriptRow,
	TranscriptSnapshot,
	TranscriptEvent
} from '$lib/types/sprocket';
import { z } from 'zod';
import { localSocket } from './socket';
import { createLocalTransport } from './transport';

const errorPayloadSchema = z.object({ error: z.string().optional() });

const agentLaunchTimeoutMs = 60_000;

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
	directories: z.array(z.string()),
	files: z.array(z.string()),
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
	threadId: convexId<'threadRecords'>()
});

const localTranscriptAttachmentSchema = z.object({
	fileId: convexId<'files'>().optional(),
	name: z.string(),
	mediaType: z.string(),
	size: z.int()
});

const transcriptUploadSuccessSchema = localTranscriptAttachmentSchema.required();

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

const transcriptRowBase = {
	id: z.string(),
	runId: z.string()
};

const transcriptRowSchema: z.ZodType<TranscriptRow> = z.discriminatedUnion('kind', [
	z.object({
		...transcriptRowBase,
		kind: z.literal('prompt'),
		text: z.string(),
		attachments: z.array(localTranscriptAttachmentSchema)
	}),
	z.object({
		...transcriptRowBase,
		kind: z.literal('text'),
		text: z.string(),
		running: z.boolean()
	}),
	z.object({
		...transcriptRowBase,
		kind: z.literal('work'),
		toolCounts: z.record(z.string(), z.int().nonnegative()),
		running: z.boolean()
	}),
	z.object({
		...transcriptRowBase,
		kind: z.literal('reasoning'),
		label: z.string(),
		running: z.boolean(),
		text: z.string().optional()
	}),
	z.object({
		...transcriptRowBase,
		kind: z.literal('tool'),
		name: z.string(),
		label: z.string().optional(),
		summary: z.string(),
		commands: z.array(z.object({ start: z.int().nonnegative(), text: z.string() })).optional(),
		hasMore: z.boolean(),
		status: z.enum(['running', 'completed', 'failed', 'cancelled']),
		error: z.string().optional(),
		action: z
			.discriminatedUnion('kind', [
				z.object({ kind: z.literal('openFile'), path: z.string() }),
				z.object({ kind: z.literal('openUrl'), url: z.string() }),
				z.object({ kind: z.literal('saveCard') })
			])
			.optional()
	})
]);

const transcriptSnapshotSchema: z.ZodType<TranscriptSnapshot> = z.object({
	type: z.literal('snapshot'),
	rows: z.array(transcriptRowSchema),
	nextBefore: z.int().nonnegative().nullable(),
	stale: z.boolean()
});

const transcriptRowResponseSchema = z.object({ row: transcriptRowSchema });

const transcriptEventSchema: z.ZodType<TranscriptEvent> = z.union([
	transcriptSnapshotSchema,
	z.object({ type: z.literal('downloading') }),
	z.object({
		type: z.literal('batch'),
		updates: z.array(
			z.discriminatedUnion('type', [
				z.object({ type: z.literal('row'), row: transcriptRowSchema }),
				z.object({
					type: z.literal('append'),
					rowId: z.string(),
					offset: z.int().nonnegative(),
					text: z.string()
				})
			])
		)
	})
]);

const chatGptStatusSchema = z.object({
	accounts: z.array(
		z.object({ connectionId: z.string(), label: z.string(), connected: z.boolean() })
	),
	activeConnectionId: z.string().nullable(),
	loginAvailable: z.boolean(),
	error: z.string().optional()
});

const chatGptBrowserLoginStartSchema = z.object({ state: z.string(), authorizeUrl: z.string() });

const toolInstallSchema = z.discriminatedUnion('state', [
	z.object({ state: z.literal('installing') }),
	z.object({ state: z.literal('installed') }),
	z.object({ state: z.literal('failed'), error: z.string() })
]);

const signInStatusSchema = z.discriminatedUnion('state', [
	z.object({ state: z.literal('idle') }),
	z.object({ state: z.literal('starting') }),
	z.object({ state: z.literal('waiting'), url: z.string(), code: z.string().nullable() }),
	z.object({ state: z.literal('failed'), error: z.string() })
]);

const gitHubStatusSchema = z.object({
	install: toolInstallSchema,
	enabled: z.boolean(),
	cliVersion: z.string().nullable(),
	hosts: z.array(
		z.object({
			host: z.string(),
			enabled: z.boolean(),
			source: z.enum(['environment', 'gitHubCli']).nullable(),
			login: z.string().nullable(),
			problem: z.string().nullable()
		})
	)
});

const vercelStatusSchema = z.object({
	install: toolInstallSchema,
	version: z.string(),
	account: z.discriminatedUnion('state', [
		z.object({ state: z.literal('signedOut') }),
		z.object({
			state: z.literal('signedIn'),
			login: z.string(),
			source: z.enum(['cli', 'environment'])
		}),
		z.object({ state: z.literal('problem'), error: z.string() })
	])
});

function signInRequest(userId: string, { connector, ...target }: SignInTarget) {
	return { path: `/api/connectors/${connector}/sign-in`, params: { userId, ...target } };
}

const connectorStatusSchema = z.object({
	id: z.literal('kicad'),
	name: z.string(),
	state: z.enum(['notInstalled', 'installing', 'failed', 'installed']),
	error: z.string().nullable(),
	updateAvailable: z.boolean(),
	kicadVersion: z.string().nullable()
});

const mcpConnectorSchema = z.object({
	id: z.string(),
	name: z.string(),
	transport: z.discriminatedUnion('type', [
		z.object({
			type: z.literal('stdio'),
			command: z.string(),
			args: z.array(z.string()),
			env: z.array(z.string())
		}),
		z.object({ type: z.literal('http'), url: z.string(), headers: z.array(z.string()) })
	])
});

const mcpToolsSchema = z.object({
	tools: z.array(
		z.object({
			name: z.string(),
			title: z.string().nullish(),
			description: z.string().nullish(),
			readOnly: z.boolean(),
			destructive: z.boolean(),
			policy: z.enum(['enabled', 'ask', 'disabled'])
		})
	)
});

function mcpConnectorPath(id: string, action: string) {
	return `/api/connectors/mcp/${encodeURIComponent(id)}/${action}`;
}

const chatGptBrowserLoginResultSchema = z.object({
	status: z.enum(['pending', 'complete', 'error']),
	error: z.string().optional()
});

const chatGptDisconnectSchema = z.object({ warning: z.string().nullable() });

const claudeCodeStatusSchema = z.object({
	state: z.enum(['notInstalled', 'installing', 'outdated', 'installed']),
	version: z.string().nullable(),
	minimumVersion: z.string(),
	installCommand: z.string(),
	error: z.string().nullable()
});

const claudeCodeLoginStartSchema = z.object({ loginId: z.string(), url: z.string() });

const claudeCodeLoginFinishSchema = z.object({ token: z.string() });

const museStatusSchema = z.object({
	state: z.enum(['notInstalled', 'installing', 'outdated', 'signedOut', 'planRequired', 'ready']),
	version: z.string().nullable(),
	minimumVersion: z.string(),
	installCommand: z.string(),
	account: z.string().nullable(),
	error: z.string().nullable()
});

const museLoginStartSchema = z.object({
	loginId: z.string(),
	verificationUrl: z.string(),
	userCode: z.string()
});

function parseProjectAttachment(
	attachment: z.infer<typeof projectAttachmentSchema>
): ProjectAttachment {
	return attachment;
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

const LOCAL_SESSION_REQUEST_TIMEOUT_MS = 15_000;

export async function bootstrapLocalSession(baseUrl: string): Promise<void> {
	const response = await fetch(`${baseUrl}/api/auth/bootstrap`, {
		method: 'POST',
		credentials: 'include',
		signal: AbortSignal.timeout(LOCAL_SESSION_REQUEST_TIMEOUT_MS)
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
		credentials: 'include',
		signal: AbortSignal.timeout(LOCAL_SESSION_REQUEST_TIMEOUT_MS)
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
		ensureBrowser: (signal) =>
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
		kicadScene: async (input, signal) => {
			const response = await transport.response('/api/workspace/file/kicad-scene', {
				method: 'POST',
				body: JSON.stringify(input),
				signal
			});

			if (!response.body) throw new Error('The board scene is empty.');

			// A stream, since `arrayBuffer()` copies the whole scene in one main-thread task.
			return { scene: response.body, version: response.headers.get('x-file-version') ?? '' };
		},
		kicadModels: async (input, signal) => {
			const response = await transport.response('/api/workspace/file/kicad-models', {
				method: 'POST',
				body: JSON.stringify(input),
				signal
			});

			return response.status === 204 ? null : response.body;
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
		fetchTranscriptRows: (requestBody, signal) =>
			request('/api/transcript/rows', transcriptSnapshotSchema, {
				method: 'POST',
				body: JSON.stringify(requestBody),
				signal
			}),
		fetchTranscriptRow: (requestBody, signal) =>
			request('/api/transcript/row', transcriptRowResponseSchema, {
				method: 'POST',
				body: JSON.stringify(requestBody),
				signal
			}),
		watchTranscript: (requestBody, handlers) =>
			socket.subscribeOnce(
				{ kind: 'transcript', params: requestBody },
				transcriptEventSchema,
				handlers.signal,
				handlers.onEvent
			),
		watchTranscriptWork: (requestBody, handlers) =>
			socket.subscribeOnce(
				{ kind: 'transcriptWork', params: requestBody },
				transcriptEventSchema,
				handlers.signal,
				handlers.onEvent
			),
		watchTranscriptItem: (requestBody, handlers) =>
			socket.subscribeOnce(
				{ kind: 'transcriptItem', params: requestBody },
				transcriptEventSchema,
				handlers.signal,
				handlers.onEvent
			),
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
					fileId: requestBody.fileId,
					threadId: requestBody.threadId
				})
			}),
		deleteArtifact: async (requestBody) => {
			await request('/api/artifacts/delete', z.null(), {
				method: 'POST',
				body: JSON.stringify(requestBody)
			});
		},
		watchArtifactSync: (requestBody, handlers) =>
			socket.subscribe({ kind: 'artifactSync', params: requestBody }, z.null(), handlers),
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
		finishChatGptBrowserLogin: async (requestBody) => {
			await request('/api/chatgpt/browser/finish', z.null(), {
				method: 'POST',
				body: JSON.stringify(requestBody)
			});
		},
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
				`/api/connectors/github?${new URLSearchParams({ userId }).toString()}`,
				gitHubStatusSchema
			),
		updateGitHubSettings: async (userId, update) =>
			await request('/api/connectors/github/settings', gitHubStatusSchema, {
				method: 'POST',
				body: JSON.stringify({ userId, ...update })
			}),
		cloneRepository: (input) =>
			request('/api/github/clone', workspacePathResolutionSchema, {
				method: 'POST',
				body: JSON.stringify(input)
			}),
		createGitHubRepository: (input) =>
			request('/api/github/repositories', workspacePathResolutionSchema, {
				method: 'POST',
				body: JSON.stringify(input)
			}),
		signOutGitHub: async (userId, host) =>
			await request('/api/connectors/github/sign-out', gitHubStatusSchema, {
				method: 'POST',
				body: JSON.stringify({ userId, host })
			}),
		fetchVercelStatus: async (userId) =>
			await request(
				`/api/connectors/vercel?${new URLSearchParams({ userId }).toString()}`,
				vercelStatusSchema
			),
		signOutVercel: async (userId) =>
			await request('/api/connectors/vercel/sign-out', vercelStatusSchema, {
				method: 'POST',
				body: JSON.stringify({ userId })
			}),
		installConnectorCli: async (userId, connector) =>
			await request(`/api/connectors/${connector}/install`, toolInstallSchema, {
				method: 'POST',
				body: JSON.stringify({ userId })
			}),
		fetchConnectorSignIn: async (userId, target) => {
			const { path, params } = signInRequest(userId, target);

			return await request(`${path}?${new URLSearchParams(params).toString()}`, signInStatusSchema);
		},
		startConnectorSignIn: async (userId, target) => {
			const { path, params } = signInRequest(userId, target);

			return await request(path, signInStatusSchema, {
				method: 'POST',
				body: JSON.stringify(params)
			});
		},
		cancelConnectorSignIn: async (userId, target) => {
			const { path, params } = signInRequest(userId, target);

			return await request(`${path}/cancel`, signInStatusSchema, {
				method: 'POST',
				body: JSON.stringify(params)
			});
		},
		fetchConnectors: async (userId) =>
			await request(
				`/api/connectors?${new URLSearchParams({ userId }).toString()}`,
				z.array(connectorStatusSchema)
			),
		installOrUpdateConnector: async (userId, id) =>
			await request(`/api/connectors/${id}/install`, connectorStatusSchema, {
				method: 'POST',
				body: JSON.stringify({ userId })
			}),
		uninstallConnector: async (userId, id) =>
			await request(`/api/connectors/${id}/uninstall`, connectorStatusSchema, {
				method: 'POST',
				body: JSON.stringify({ userId })
			}),
		fetchMcpConnectors: async (userId) =>
			await request(
				`/api/connectors/mcp?${new URLSearchParams({ userId }).toString()}`,
				z.array(mcpConnectorSchema)
			),
		addMcpConnector: async (userId, connector) =>
			await request('/api/connectors/mcp', mcpConnectorSchema, {
				method: 'POST',
				body: JSON.stringify({ userId, ...connector })
			}),
		removeMcpConnector: async (userId, id) => {
			await transport.response(mcpConnectorPath(id, 'delete'), {
				method: 'POST',
				body: JSON.stringify({ userId })
			});
		},
		fetchMcpTools: async (userId, id) => {
			const { tools } = await request(
				`${mcpConnectorPath(id, 'tools')}?${new URLSearchParams({ userId }).toString()}`,
				mcpToolsSchema
			);

			return tools;
		},
		setMcpToolPolicy: async (userId, id, tool, policy) => {
			await transport.response(mcpConnectorPath(id, 'policy'), {
				method: 'POST',
				body: JSON.stringify({ userId, tool, policy })
			});
		},
		fetchClaudeCodeStatus: async (userId) =>
			await request(
				`/api/claude-code?${new URLSearchParams({ userId }).toString()}`,
				claudeCodeStatusSchema
			),
		installClaudeCode: async (userId) =>
			await request('/api/claude-code/install', claudeCodeStatusSchema, {
				method: 'POST',
				body: JSON.stringify({ userId })
			}),
		startClaudeCodeLogin: async (userId) =>
			await request('/api/claude-code/login/start', claudeCodeLoginStartSchema, {
				method: 'POST',
				body: JSON.stringify({ userId })
			}),
		finishClaudeCodeLogin: async (userId, loginId, code) => {
			const { token } = await request(
				'/api/claude-code/login/finish',
				claudeCodeLoginFinishSchema,
				{ method: 'POST', body: JSON.stringify({ userId, loginId, code }) }
			);

			return token;
		},
		cancelClaudeCodeLogin: async (userId, loginId) => {
			await transport.response('/api/claude-code/login/cancel', {
				method: 'POST',
				body: JSON.stringify({ userId, loginId })
			});
		},
		fetchMuseStatus: async (userId) =>
			await request(`/api/muse?${new URLSearchParams({ userId }).toString()}`, museStatusSchema),
		installMuse: async (userId) =>
			await request('/api/muse/install', museStatusSchema, {
				method: 'POST',
				body: JSON.stringify({ userId })
			}),
		startMuseLogin: async (userId) =>
			await request('/api/muse/login/start', museLoginStartSchema, {
				method: 'POST',
				body: JSON.stringify({ userId })
			}),
		cancelMuseLogin: async (userId, loginId) => {
			await transport.response('/api/muse/login/cancel', {
				method: 'POST',
				body: JSON.stringify({ userId, loginId })
			});
		}
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
