import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
	ChatGptStatus,
	TranscriptEvent,
	TranscriptRow,
	TranscriptSnapshot
} from '$lib/types/sprocket';
import {
	createLocalClient,
	ensureLocalSession,
	readWorkspaceLaunchFromHash,
	workspaceLaunchHash
} from '$lib/local/client';
import { stubWebSocket } from '$lib/local/socket-test-support';
import { fixtureId } from '$lib/convex-test-client';

const threadRecordId = fixtureId<'threadRecords'>;

const fileId = fixtureId<'files'>;

const runId = fixtureId<'runs'>;

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('local session bootstrap', () => {
	it("shares startup bootstrap so auth and the local API do not replace each other's cookie", async () => {
		vi.stubGlobal('window', { location: { hash: '' } });

		const fetch = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith('/api/auth/session')) {
				return Response.json({ authenticated: false });
			}

			expect(init).toMatchObject({ method: 'POST', credentials: 'include' });

			return Response.json({ authenticated: true });
		});

		vi.stubGlobal('fetch', fetch);
		await Promise.all([
			ensureLocalSession('http://localhost:17731'),
			ensureLocalSession('http://localhost:17731')
		]);
		expect(fetch.mock.calls.map(([url]) => url)).toEqual([
			'http://localhost:17731/api/auth/session',
			'http://localhost:17731/api/auth/bootstrap'
		]);

		fetch.mockClear();
		await ensureLocalSession('http://localhost:17731');
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});

describe('workspace launch fragments', () => {
	it('round-trips paths containing URL metacharacters', () => {
		const workspacePath = '/robots/arm & gripper';
		const hash = workspaceLaunchHash(workspacePath);
		vi.stubGlobal('window', { location: { hash } });

		expect(hash).toBe('#workspace=%2Frobots%2Farm+%26+gripper');
		expect(readWorkspaceLaunchFromHash()).toBe(workspacePath);
	});
});

describe('KiCad component models', () => {
	it('returns no stream for a board without models', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(null, { status: 204 }))
		);

		await expect(
			createLocalClient('http://127.0.0.1:7731').kicadModels({
				workspacePath: '/work',
				path: 'board.kicad_pcb'
			})
		).resolves.toBeNull();
	});
});

describe('workspace skill listing', () => {
	it('preserves invocation policy for the composer command menu', async () => {
		const result = {
			skills: [
				{ name: 'deploy', description: 'Deploy apps', disableModelInvocation: true },
				{ name: 'review', description: 'Review code', disableModelInvocation: false }
			],
			warnings: []
		};

		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json(result))
		);
		await expect(
			createLocalClient('http://127.0.0.1:7731').listWorkspaceSkills({ workspacePath: '/work' })
		).resolves.toEqual(result);
	});
});

describe('workspace path search', () => {
	it('passes the workspace, query, and cancellation signal to the server', async () => {
		const result = {
			entries: [{ path: 'src', kind: 'directory' }],
			scanning: false
		};

		const fetch = vi.fn(async () => Response.json(result));
		vi.stubGlobal('fetch', fetch);
		const controller = new AbortController();

		await expect(
			createLocalClient('http://127.0.0.1:7731').searchWorkspace(
				{ workspacePath: '/workspace', query: 'src' },
				controller.signal
			)
		).resolves.toEqual(result);
		expect(fetch).toHaveBeenCalledWith(
			'http://127.0.0.1:7731/api/workspace/search',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ workspacePath: '/workspace', query: 'src' }),
				signal: controller.signal
			})
		);
	});
});

it('preserves local project send times when listing and attaching projects', async () => {
	const attachment = {
		workspacePath: '/work/robot',
		repositoryKey: 'robot',
		attachmentKey: 'directory:robot',
		displayName: 'Robot',
		availability: 'available',
		lastValidatedAt: 30,
		lastUsedAt: 10,
		lastMessageSentAt: 20
	};

	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init?: RequestInit) =>
			Response.json(init?.method === 'POST' ? attachment : [attachment])
		)
	);
	const client = createLocalClient('http://127.0.0.1:7731');
	expect(await client.listProjectAttachments()).toEqual([attachment]);
	expect(await client.attachProject({ workspacePath: attachment.workspacePath })).toEqual(
		attachment
	);
});

it('removes a project through the server', async () => {
	const fetch = vi.fn(async () => Response.json(null));
	vi.stubGlobal('fetch', fetch);
	const workspacePath = 'D:\\robots';
	await createLocalClient('http://127.0.0.1:7731').removeProject({ workspacePath });
	expect(fetch).toHaveBeenCalledWith(
		'http://127.0.0.1:7731/api/workspace/projects',
		expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ workspacePath }) })
	);
});

describe('transcript protocol', () => {
	const scope = { userId: 'user-1', threadId: threadRecordId('thread-1') };

	const textRow: TranscriptRow = {
		id: 'completion:0',
		runId: 'run-1',
		kind: 'text',
		text: 'Hi 🛠',
		running: true
	};

	const reasoningRow: TranscriptRow = {
		id: 'completion:1',
		runId: 'run-1',
		kind: 'reasoning',
		label: 'Checking the result',
		running: true,
		text: 'Checking 🛠\nThe result is correct.'
	};

	const toolRow: TranscriptRow = {
		id: 'completion:2',
		runId: 'run-1',
		kind: 'tool',
		name: 'exec_cmd',
		summary: 'bun test',
		hasMore: true,
		status: 'completed'
	};

	const snapshot: TranscriptSnapshot = {
		type: 'snapshot',
		rows: [
			{
				id: 'prompt',
				runId: 'run-1',
				kind: 'prompt',
				text: 'Inspect this',
				attachments: [
					{
						fileId: fileId('file-1'),
						name: 'shot.png',
						mediaType: 'image/png',
						size: 12
					}
				]
			},
			textRow,
			{ id: 'work:0', runId: 'run-1', kind: 'work', toolCounts: { exec_cmd: 2 }, running: true },
			reasoningRow,
			toolRow
		],
		nextBefore: 200,
		stale: true
	};

	it('fetches older snapshot rows and pagination and forwards the signal', async () => {
		const request = { ...scope, before: 400 };
		const fetch = vi.fn(async () => Response.json(snapshot));
		vi.stubGlobal('fetch', fetch);
		const controller = new AbortController();

		await expect(
			createLocalClient('http://127.0.0.1:7731').fetchTranscriptRows(request, controller.signal)
		).resolves.toEqual(snapshot);
		expect(fetch).toHaveBeenCalledWith(
			'http://127.0.0.1:7731/api/transcript/rows',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify(request),
				signal: controller.signal
			})
		);
	});

	it.each(['running', 'completed', 'failed', 'cancelled'] as const)(
		'preserves tool rows with %s status and actions',
		async (status) => {
			const row: TranscriptRow = {
				...toolRow,
				status,
				label: 'Run command',
				summary: 'bun test\nFull command summary',
				commands: [{ start: 0, text: 'bun test' }],
				hasMore: false,
				action:
					status === 'completed'
						? { kind: 'saveCard' }
						: { kind: 'openFile', path: '/work/test.ts' }
			};

			if (status === 'failed') row.error = 'Command exited with code 1';

			const response: TranscriptSnapshot = { ...snapshot, rows: [row], nextBefore: null };
			const fetch = vi.fn(async () => Response.json(response));
			vi.stubGlobal('fetch', fetch);
			const request = { ...scope, before: 400 };
			const controller = new AbortController();

			await expect(
				createLocalClient('http://127.0.0.1:7731').fetchTranscriptRows(request, controller.signal)
			).resolves.toEqual(response);
			expect(fetch).toHaveBeenCalledWith(
				'http://127.0.0.1:7731/api/transcript/rows',
				expect.objectContaining({
					method: 'POST',
					body: JSON.stringify(request),
					signal: controller.signal
				})
			);
		}
	);

	it.each([textRow, reasoningRow, toolRow])('fetches the full $kind row', async (row) => {
		const response = { row };
		const fetch = vi.fn(async () => Response.json(response));
		vi.stubGlobal('fetch', fetch);
		const request = { ...scope, rowId: row.id };
		const controller = new AbortController();

		await expect(
			createLocalClient('http://127.0.0.1:7731').fetchTranscriptRow(request, controller.signal)
		).resolves.toEqual(response);
		expect(fetch).toHaveBeenCalledWith(
			'http://127.0.0.1:7731/api/transcript/row',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify(request),
				signal: controller.signal
			})
		);
	});

	it('cancels an in-flight page request when its thread is left', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				(_url: string, init: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
					})
			)
		);
		const controller = new AbortController();

		const pending = createLocalClient('http://127.0.0.1:7731').fetchTranscriptRows(
			{ ...scope, before: 400 },
			controller.signal
		);

		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
	});

	it.each([
		['watchTranscript', 'transcript', scope],
		['watchTranscript', 'transcript', { ...scope, before: 200 }],
		['watchTranscript', 'transcript', { ...scope, before: 0 }],
		['watchTranscriptWork', 'transcriptWork', { ...scope, rowId: 'work:0' }],
		['watchTranscriptItem', 'transcriptItem', { ...scope, rowId: reasoningRow.id }]
	] as const)(
		'%s delivers batched snapshots and row/UTF-16 append updates and cancels',
		async (...[method, kind, request]) => {
			const sockets = stubWebSocket();
			const controller = new AbortController();
			const onEvent = vi.fn();
			const client = createLocalClient('http://127.0.0.1:7101');
			const handlers = { signal: controller.signal, onEvent };

			const watching =
				method === 'watchTranscript'
					? client.watchTranscript(request, handlers)
					: client[method](request, handlers);

			sockets[0].open();
			expect(sockets[0].sent).toEqual([
				{ type: 'subscribe', id: 1, topic: { kind, params: request } }
			]);

			const updates: TranscriptEvent = {
				type: 'batch',
				updates: [
					{ type: 'row', row: { ...toolRow, status: 'failed', error: 'Command failed' } },
					{ type: 'append', rowId: textRow.id, offset: 5, text: ' done' }
				]
			};

			sockets[0].receive(
				{ type: 'event', id: 1, data: snapshot },
				{ type: 'event', id: 1, data: updates }
			);
			expect(onEvent.mock.calls).toEqual([[snapshot], [updates]]);
			controller.abort();
			await expect(watching).resolves.toBeUndefined();
			expect(sockets[0].sent.at(-1)).toEqual({ type: 'unsubscribe', id: 1 });
		}
	);

	it('rejects a watch with an invalid transcript payload', async () => {
		const sockets = stubWebSocket();
		const onEvent = vi.fn();

		const watching = createLocalClient('http://127.0.0.1:7101').watchTranscript(scope, {
			signal: new AbortController().signal,
			onEvent
		});

		const rejected = expect(watching).rejects.toMatchObject({ name: 'ZodError' });
		sockets[0].open();
		sockets[0].receive({
			type: 'event',
			id: 1,
			data: { type: 'snapshot', rows: [{}], nextBefore: null, stale: false }
		});
		await rejected;
		expect(sockets[0].sent.at(-1)).toEqual({ type: 'unsubscribe', id: 1 });
	});
});

describe('deleteArtifact', () => {
	const request = {
		userId: 'alice',
		repositoryKey: 'robot',
		workspacePath: '/workspace',
		artifactId: 'artifact'
	};

	it('deletes through the local server with the account and workspace scope', async () => {
		const fetch = vi.fn(async () => Response.json(null));
		vi.stubGlobal('fetch', fetch);
		await createLocalClient('http://127.0.0.1:7731').deleteArtifact(request);
		expect(fetch).toHaveBeenCalledWith(
			'http://127.0.0.1:7731/api/artifacts/delete',
			expect.objectContaining({ method: 'POST', body: JSON.stringify(request) })
		);
	});
});

describe('watchArtifactSync', () => {
	it('subscribes with the artifact scope and delivers sync ticks', async () => {
		const sockets = stubWebSocket();
		const request = { userId: 'user-1', repositoryKey: 'repo-1', workspacePath: '/ws' };
		const onEvent = vi.fn();
		const controller = new AbortController();

		const watching = createLocalClient('http://127.0.0.1:7102').watchArtifactSync(request, {
			signal: controller.signal,
			onEvent,
			onError: vi.fn()
		});

		sockets[0].open();
		expect(sockets[0].sent).toEqual([
			{ type: 'subscribe', id: 1, topic: { kind: 'artifactSync', params: request } }
		]);
		sockets[0].receive({ type: 'event', id: 1, data: null });
		controller.abort();
		await watching;
		expect(onEvent).toHaveBeenCalledWith(null);
	});
});

describe('run cancellation local API', () => {
	it('accepts the boolean returned by the cancellation mutation', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response('true', {
						status: 200,
						headers: { 'content-type': 'application/json' }
					})
			)
		);

		await expect(
			createLocalClient('http://127.0.0.1:7731').requestRunCancellation({
				userId: 'user-1',
				runId: runId('run-1')
			})
		).resolves.toBeUndefined();
	});
});

describe('account session local API', () => {
	it('starts and ends machine presence for the signed-in user', async () => {
		const fetch = vi.fn(async () => Response.json(null));
		vi.stubGlobal('fetch', fetch);
		const client = createLocalClient('http://127.0.0.1:7731');
		const request = { userId: 'user-1' };

		await client.startAccountSession(request);
		await client.endAccountSession(request);

		expect(fetch).toHaveBeenNthCalledWith(
			1,
			'http://127.0.0.1:7731/api/threads/account-session/start',
			expect.objectContaining({ method: 'POST', body: JSON.stringify(request) })
		);
		expect(fetch).toHaveBeenNthCalledWith(
			2,
			'http://127.0.0.1:7731/api/threads/account-session/end',
			expect.objectContaining({ method: 'POST', body: JSON.stringify(request) })
		);
	});
});

describe('transcript file upload', () => {
	it('posts the raw file through the authenticated helper', async () => {
		const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });

		const fetch = vi.fn(async () =>
			Response.json({
				fileId: 'file-1',
				name: 'notes.txt',
				mediaType: 'text/plain',
				size: 5
			})
		);

		vi.stubGlobal('fetch', fetch);

		const result = await createLocalClient('http://127.0.0.1:7731').uploadTranscriptAttachment({
			userId: 'user/1',
			name: 'spec & notes.pdf',
			file,
			threadId: threadRecordId('thread/1')
		});

		expect(result).toEqual({
			fileId: 'file-1',
			name: 'notes.txt',
			mediaType: 'text/plain',
			size: 5
		});
		expect(fetch).toHaveBeenCalledWith(
			'http://127.0.0.1:7731/api/transcript/upload?userId=user%2F1&name=spec%20%26%20notes.pdf&threadId=thread%2F1',
			expect.objectContaining({
				method: 'POST',
				credentials: 'include',
				headers: expect.objectContaining({ 'content-type': 'text/plain' }),
				body: file
			})
		);
	});

	it('uses octet-stream when the file has no MIME type', async () => {
		const file = new File(['blob'], 'blob.bin', { type: '' });

		const fetch = vi.fn(async () =>
			Response.json({
				error: 'staged'
			})
		);

		vi.stubGlobal('fetch', fetch);

		await expect(
			createLocalClient('http://127.0.0.1:7731').uploadTranscriptAttachment({
				userId: 'user-1',
				name: 'blob.bin',
				file
			})
		).resolves.toEqual({ error: 'staged' });
		expect(fetch).toHaveBeenCalledWith(
			'http://127.0.0.1:7731/api/transcript/upload?userId=user-1&name=blob.bin',
			expect.objectContaining({
				headers: expect.objectContaining({ 'content-type': 'application/octet-stream' }),
				body: file
			})
		);
	});
});

describe('agent launch', () => {
	it('stops waiting for an agent launch the server never answers', async () => {
		vi.spyOn(AbortSignal, 'timeout').mockReturnValue(
			AbortSignal.abort(new DOMException('signal timed out', 'TimeoutError'))
		);
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string, init?: RequestInit) => {
				throw init?.signal?.reason;
			})
		);

		await expect(
			createLocalClient('http://127.0.0.1:7731').runAgent({
				userId: 'user-1',
				prompt: 'Inspect src/lib.rs',
				fileIds: [],
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				fastMode: false,
				submissionId: 'submission-1',
				workspacePath: '/work'
			})
		).rejects.toThrow('The local server did not start the agent in time. Try again.');
	});
});

describe('transcript attachment discard', () => {
	it('posts the originating user, upload, and thread', async () => {
		const fetch = vi.fn(
			async () =>
				new Response('true', {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
		);

		vi.stubGlobal('fetch', fetch);

		await expect(
			createLocalClient('http://127.0.0.1:7731').discardTranscriptAttachment({
				userId: 'user-1',
				fileId: fileId('file-1'),
				threadId: threadRecordId('thread-1')
			})
		).resolves.toBe(true);

		expect(fetch).toHaveBeenCalledWith(
			'http://127.0.0.1:7731/api/transcript/discard',
			expect.objectContaining({
				method: 'POST',
				credentials: 'include'
			})
		);
		expect(fetch).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				body: JSON.stringify({ userId: 'user-1', fileId: 'file-1', threadId: 'thread-1' })
			})
		);
	});

	it('omits threadId and returns false when the file is absent or attached', async () => {
		const fetch = vi.fn(
			async () =>
				new Response('false', {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
		);

		vi.stubGlobal('fetch', fetch);

		await expect(
			createLocalClient('http://127.0.0.1:7731').discardTranscriptAttachment({
				userId: 'user-1',
				fileId: fileId('file-1')
			})
		).resolves.toBe(false);

		expect(fetch).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				body: JSON.stringify({ userId: 'user-1', fileId: 'file-1' })
			})
		);
	});
});

describe('transcript attachment fetch', () => {
	it('posts fileId with the thread scope', async () => {
		const fetch = vi.fn(async () => new Response(new Blob(['png']), { status: 200 }));
		vi.stubGlobal('fetch', fetch);

		const blob = await createLocalClient('http://127.0.0.1:7731').fetchTranscriptAttachment({
			userId: 'user-1',
			threadId: threadRecordId('thread-1'),
			fileId: fileId('file-1')
		});

		expect(blob).toBeInstanceOf(Blob);
		expect(fetch).toHaveBeenCalledWith(
			'http://127.0.0.1:7731/api/transcript/attachment',
			expect.objectContaining({
				method: 'POST',
				credentials: 'include',
				body: JSON.stringify({
					userId: 'user-1',
					threadId: 'thread-1',
					fileId: 'file-1'
				})
			})
		);
	});
});

describe('chatgpt local sign-in', () => {
	it.each([undefined, 'ChatGPT refresh is temporarily unavailable. Retry later.'])(
		'fetches account status with optional guidance %s',
		async (error) => {
			const status: ChatGptStatus = {
				accounts: [{ connectionId: 'conn-1', label: 'a@example.com', connected: true }],
				activeConnectionId: 'conn-1',
				loginAvailable: true
			};

			if (error) status.error = error;
			const fetch = vi.fn(async () => Response.json(status));
			vi.stubGlobal('fetch', fetch);

			const result = await createLocalClient('http://127.0.0.1:7731').fetchChatGptStatus({
				userId: 'user-1'
			});

			expect(result).toEqual(status);
			expect(fetch).toHaveBeenCalledWith(
				'http://127.0.0.1:7731/api/chatgpt/status',
				expect.objectContaining({ method: 'POST', body: JSON.stringify({ userId: 'user-1' }) })
			);
		}
	);

	it('starts a browser login without exposing codes or tokens to the browser', async () => {
		const fetch = vi.fn(async () =>
			Response.json({ state: 'state-1', authorizeUrl: 'https://auth.openai.test/authorize' })
		);

		vi.stubGlobal('fetch', fetch);

		const result = await createLocalClient('http://127.0.0.1:7731').startChatGptBrowserLogin({
			userId: 'user-1',
			connectionId: 'conn-1'
		});

		expect(result).toEqual({
			state: 'state-1',
			authorizeUrl: 'https://auth.openai.test/authorize'
		});
		expect(fetch).toHaveBeenCalledWith(
			'http://127.0.0.1:7731/api/chatgpt/browser/start',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ userId: 'user-1', connectionId: 'conn-1' })
			})
		);
	});

	it('never exposes an authorization code from the start payload', async () => {
		const fetch = vi.fn(async () =>
			Response.json({ state: 'state-1', authorizeUrl: 'https://x.test', code: 'leaked' })
		);

		vi.stubGlobal('fetch', fetch);

		const result = await createLocalClient('http://127.0.0.1:7731').startChatGptBrowserLogin({
			userId: 'user-1'
		});

		expect(result).toEqual({ state: 'state-1', authorizeUrl: 'https://x.test' });
	});

	it('polls the login result by state', async () => {
		const fetch = vi.fn(async () => Response.json({ status: 'pending' }));
		vi.stubGlobal('fetch', fetch);

		const result = await createLocalClient('http://127.0.0.1:7731').fetchChatGptBrowserLoginResult({
			userId: 'user-1',
			state: 'state-1'
		});

		expect(result).toEqual({ status: 'pending' });
		expect(fetch).toHaveBeenCalledWith(
			'http://127.0.0.1:7731/api/chatgpt/browser/result',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ userId: 'user-1', state: 'state-1' })
			})
		);
	});

	it('cancels a login by state', async () => {
		const fetch = vi.fn(async () => Response.json(null));
		vi.stubGlobal('fetch', fetch);

		await createLocalClient('http://127.0.0.1:7731').cancelChatGptBrowserLogin({
			userId: 'user-1',
			state: 'state-1'
		});

		expect(fetch).toHaveBeenCalledWith(
			'http://127.0.0.1:7731/api/chatgpt/browser/cancel',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ userId: 'user-1', state: 'state-1' })
			})
		);
	});

	it('selects the active connection', async () => {
		const fetch = vi.fn(async () => Response.json(null));
		vi.stubGlobal('fetch', fetch);

		await createLocalClient('http://127.0.0.1:7731').selectChatGptAccount({
			userId: 'user-1',
			connectionId: 'conn-2'
		});

		expect(fetch).toHaveBeenCalledWith(
			'http://127.0.0.1:7731/api/chatgpt/select',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ userId: 'user-1', connectionId: 'conn-2' })
			})
		);
	});

	it('disconnects a connection and returns the server warning', async () => {
		const fetch = vi.fn(async () => Response.json({ warning: 'In-flight runs keep going.' }));
		vi.stubGlobal('fetch', fetch);

		const warning = await createLocalClient('http://127.0.0.1:7731').disconnectChatGptAccount({
			userId: 'user-1',
			connectionId: 'conn-1'
		});

		expect(warning).toBe('In-flight runs keep going.');
		expect(fetch).toHaveBeenCalledWith(
			'http://127.0.0.1:7731/api/chatgpt/disconnect',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ userId: 'user-1', connectionId: 'conn-1' })
			})
		);
	});
});

describe('running command controls', () => {
	it('watches the thread scope and sends scoped termination requests', async () => {
		const commands = [{ sessionId: '7', command: 'bun run dev', workdir: '/work', startedAt: 100 }];
		const sockets = stubWebSocket();
		const fetch = vi.fn().mockResolvedValueOnce(Response.json({ terminated: true }));
		vi.stubGlobal('fetch', fetch);
		const api = createLocalClient('http://localhost:17731');
		const scope = { userId: 'user', threadId: threadRecordId('thread') };
		const onEvent = vi.fn();
		const controller = new AbortController();

		const watching = api.watchRunningCommands(scope, {
			signal: controller.signal,
			onEvent,
			onError: vi.fn()
		});

		sockets[0].open();
		expect(sockets[0].sent).toEqual([
			{ type: 'subscribe', id: 1, topic: { kind: 'commands', params: scope } }
		]);
		sockets[0].receive({ type: 'event', id: 1, data: commands });
		controller.abort();
		await watching;
		expect(onEvent).toHaveBeenCalledWith(commands);
		await expect(api.terminateCommand({ ...scope, sessionId: '7' })).resolves.toEqual({
			terminated: true
		});
		expect(fetch).toHaveBeenCalledWith(
			'http://localhost:17731/api/agent/commands/terminate',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ ...scope, sessionId: '7' })
			})
		);
	});
});
