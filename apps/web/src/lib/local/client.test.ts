import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '$convex/_generated/dataModel';
import {
	createLocalClient,
	ensureLocalSession,
	readWorkspaceLaunchFromHash,
	workspaceLaunchHash
} from '$lib/local/client';
import { threadRecordToSummary } from '$lib/project/threads';

function threadRecordId(value: string): Id<'threadRecords'> {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return value as Id<'threadRecords'>;
}

function storageId(value: string): Id<'_storage'> {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return value as Id<'_storage'>;
}

function runId(value: string): Id<'runs'> {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return value as Id<'runs'>;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('local pairing', () => {
	it("shares startup pairing so auth and the local API do not replace each other's cookie", async () => {
		vi.stubGlobal('window', { location: { hash: '' } });
		const fetch = vi.fn(async (url: string) => {
			if (url.endsWith('/api/auth/session')) {
				return Response.json({ authenticated: false });
			}
			return Response.json({ authenticated: true });
		});
		vi.stubGlobal('fetch', fetch);
		const bootstrap = { httpBaseUrl: 'http://localhost:17731', pairingCredential: 'test' };
		await Promise.all([
			ensureLocalSession(bootstrap.httpBaseUrl, bootstrap),
			ensureLocalSession(bootstrap.httpBaseUrl, bootstrap)
		]);
		expect(fetch.mock.calls.map(([url]) => url)).toEqual([
			`${bootstrap.httpBaseUrl}/api/auth/session`,
			`${bootstrap.httpBaseUrl}/api/auth/bootstrap`
		]);

		fetch.mockClear();
		await ensureLocalSession(bootstrap.httpBaseUrl, bootstrap);
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

describe('projected transcript pages', () => {
	it('cancels an in-flight page request when its thread is left', async () => {
		const fetch = vi.fn(
			(_url: string, init: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
				})
		);
		vi.stubGlobal('fetch', fetch);
		const controller = new AbortController();
		const pending = createLocalClient('http://127.0.0.1:7731').fetchTranscriptPage(
			{ userId: 'user-1', threadId: threadRecordId('thread-1'), limit: 12 },
			controller.signal
		);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		expect(fetch).toHaveBeenCalledWith(
			'http://127.0.0.1:7731/api/transcript/parts',
			expect.objectContaining({ signal: controller.signal })
		);
	});

	it('uses the part-bounded endpoint without falling back to message paging', async () => {
		const message = {
			id: 'response:run-1',
			threadId: 'thread-1',
			runId: 'run-1',
			userId: 'user-1',
			type: 'response',
			text: 'Last completion',
			attachments: [],
			parts: [{ type: 'text', id: 'text-499', text: 'Last completion' }],
			runStatus: 'completed',
			runStartedAt: 1,
			sourceNumbers: [499],
			streamIds: ['stream-499'],
			detailsLoaded: false
		};
		const parts = [
			{ number: 498, kind: 'completion', message: null },
			{ number: 499, kind: 'completion', message }
		];
		const fetch = vi.fn(async () =>
			Response.json({
				threadId: 'thread-1',
				totalParts: 500,
				historyFromNumber: 498,
				stale: false,
				parts,
				nextBefore: 498
			})
		);
		vi.stubGlobal('fetch', fetch);
		const page = await createLocalClient('http://127.0.0.1:7731').fetchTranscriptPage({
			userId: 'user-1',
			threadId: threadRecordId('thread-1'),
			limit: 12
		});
		expect(page.nextBefore).toBe(498);
		expect(page.parts).toEqual([
			parts[0],
			{ ...parts[1], message: { ...message, id: undefined, _id: message.id } }
		]);
		expect(fetch).toHaveBeenCalledWith(
			'http://127.0.0.1:7731/api/transcript/parts',
			expect.objectContaining({ method: 'POST' })
		);
	});

	it('maps storageId attachment metadata and ignores leftover imageUploadId', async () => {
		const fetch = vi.fn(async () =>
			Response.json({
				threadId: 'thread-1',
				totalParts: 1,
				historyFromNumber: 0,
				stale: false,
				parts: [
					{
						number: 0,
						kind: 'prompt',
						message: {
							id: 'prompt:1',
							threadId: 'thread-1',
							runId: 'run-1',
							userId: 'user-1',
							type: 'prompt',
							text: 'Inspect this',
							attachments: [
								{
									imageUploadId: 'upload-1',
									storageId: 'storage-1',
									name: 'shot.png',
									mediaType: 'image/png',
									size: 12,
									url: 'http://127.0.0.1:7731/files/shot.png'
								}
							],
							parts: [],
							runStatus: 'completed',
							runStartedAt: 1,
							sourceNumbers: [0],
							streamIds: [],
							detailsLoaded: true
						}
					}
				]
			})
		);
		vi.stubGlobal('fetch', fetch);

		const page = await createLocalClient('http://127.0.0.1:7731').fetchTranscriptPage({
			userId: 'user-1',
			threadId: threadRecordId('thread-1')
		});

		expect(page.parts[0]?.message?.attachments).toEqual([
			{
				storageId: 'storage-1',
				name: 'shot.png',
				mediaType: 'image/png',
				size: 12,
				url: 'http://127.0.0.1:7731/files/shot.png'
			}
		]);
	});

	it('requests cancellable per-part details and preserves non-display part numbers', async () => {
		const fetch = vi.fn(async () =>
			Response.json([{ number: 498, kind: 'completion', message: null }])
		);
		vi.stubGlobal('fetch', fetch);
		const controller = new AbortController();
		const request = { userId: 'user-1', threadId: threadRecordId('thread-1'), numbers: [498] };
		const details = await createLocalClient('http://127.0.0.1:7731').fetchTranscriptDetails(
			request,
			controller.signal
		);
		expect(details).toEqual([{ number: 498, kind: 'completion', message: null }]);
		expect(fetch).toHaveBeenCalledWith(
			'http://127.0.0.1:7731/api/transcript/part-details',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify(request),
				signal: controller.signal
			})
		);
	});
});

describe('watchLiveCompletion', () => {
	it('parses updated and cleared SSE events', async () => {
		const overlay = {
			threadId: 'thread-1',
			runId: 'run-1',
			runStatus: 'running' as const,
			streamId: 'stream-1',
			text: 'Hello',
			parts: [{ type: 'text' as const, id: 't', text: 'Hello', turnId: 'stream-1' }],
			runStartedAt: 1
		};
		const encoder = new TextEncoder();
		const body = new ReadableStream({
			start(controller) {
				controller.enqueue(
					encoder.encode(`data: ${JSON.stringify({ eventType: 'updated', live: overlay })}\n\n`)
				);
				controller.enqueue(encoder.encode('data: {"eventType":"cleared"}\n\n'));
				controller.close();
			}
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(body, { status: 200 }))
		);

		const events: unknown[] = [];
		await createLocalClient('http://127.0.0.1:7731').watchLiveCompletion(
			{ userId: 'user-1', threadId: threadRecordId('thread-1') },
			{
				signal: new AbortController().signal,
				onEvent: (event) => {
					events.push(event);
				}
			}
		);

		expect(events).toEqual([{ eventType: 'updated', live: overlay }, { eventType: 'cleared' }]);
	});
});

describe('thread cache local API', () => {
	it('parses snapshot threads without status and watch status events', async () => {
		const snapshot = {
			threads: [
				{
					_id: 'thread-1',
					_creationTime: 1,
					userId: 'user-1',
					submissionId: 'submission-1',
					repositoryKey: 'alpha',
					title: 'Hello',
					selectedModel: 'gpt-5.6-sol',
					reasoningEffort: 'medium',
					fastMode: false,
					lastMessageAt: 10
				},
				{
					_id: 'thread-2',
					_creationTime: 2,
					userId: 'user-1',
					submissionId: 'submission-2',
					repositoryKey: 'alpha',
					title: 'Fast thread',
					selectedModel: 'gpt-5.6-sol',
					reasoningEffort: 'high',
					fastMode: true,
					lastMessageAt: 20
				}
			],
			status: 'live',
			lastSyncedAt: 20
		};
		const encoder = new TextEncoder();
		const body = new ReadableStream({
			start(controller) {
				controller.enqueue(
					encoder.encode(`data: ${JSON.stringify({ status: 'live', lastSyncedAt: 20 })}\n\n`)
				);
				controller.close();
			}
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.endsWith('/api/threads/snapshot')) {
					return new Response(JSON.stringify(snapshot), {
						status: 200,
						headers: { 'content-type': 'application/json' }
					});
				}
				return new Response(body, { status: 200 });
			})
		);

		const client = createLocalClient('http://127.0.0.1:7731');
		const parsedSnapshot = await client.fetchThreadSnapshot({ userId: 'user-1' });
		expect(parsedSnapshot).toEqual({
			threads: [
				{
					_id: 'thread-1',
					_creationTime: 1,
					userId: 'user-1',
					submissionId: 'submission-1',
					repositoryKey: 'alpha',
					title: 'Hello',
					selectedModel: 'gpt-5.6-sol',
					reasoningEffort: 'medium',
					fastMode: false,
					lastMessageAt: 10
				},
				{
					_id: 'thread-2',
					_creationTime: 2,
					userId: 'user-1',
					submissionId: 'submission-2',
					repositoryKey: 'alpha',
					title: 'Fast thread',
					selectedModel: 'gpt-5.6-sol',
					reasoningEffort: 'high',
					fastMode: true,
					lastMessageAt: 20
				}
			],
			status: 'live',
			lastSyncedAt: 20
		});
		expect(threadRecordToSummary(parsedSnapshot.threads[0]!).status).toBe('completed');
		expect(threadRecordToSummary(parsedSnapshot.threads[0]!).fastMode).toBe(false);
		expect(threadRecordToSummary(parsedSnapshot.threads[1]!).fastMode).toBe(true);

		const events: unknown[] = [];
		await client.watchThreadCache(
			{ userId: 'user-1' },
			{
				signal: new AbortController().signal,
				onEvent: (event) => {
					events.push(event);
				}
			}
		);
		expect(events).toEqual([{ status: 'live', lastSyncedAt: 20 }]);
	});
});

describe('watchArtifacts', () => {
	const artifact = {
		_id: 'artifact-1',
		userId: 'user-1',
		scope: 'project' as const,
		repositoryKey: 'repo-1',
		localPath: 'docs/spec.md',
		content: '# Spec',
		type: 'markdown' as const,
		title: 'Spec',
		revision: 1,
		createdAt: 10,
		updatedAt: 20
	};

	function sseResponse(events: unknown[]) {
		const encoder = new TextEncoder();
		return new ReadableStream({
			start(controller) {
				for (const event of events) {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
				}
				controller.close();
			}
		});
	}

	it('posts the watch request and parses full-snapshot SSE events', async () => {
		const fetch = vi.fn(
			async () =>
				new Response(sseResponse([{ artifacts: [artifact], stale: false }]), { status: 200 })
		);
		vi.stubGlobal('fetch', fetch);

		const events: unknown[] = [];
		const request = {
			userId: 'user-1',
			repositoryKey: 'repo-1',
			workspacePath: '/ws'
		};
		await createLocalClient('http://127.0.0.1:7731').watchArtifacts(request, {
			signal: new AbortController().signal,
			onEvent: (event) => {
				events.push(event);
			}
		});

		expect(fetch).toHaveBeenCalledWith(
			'http://127.0.0.1:7731/api/artifacts/watch',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify(request)
			})
		);
		expect(events).toEqual([{ artifacts: [artifact], stale: false }]);
	});

	it('rejects malformed snapshots so callers can reconnect', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						sseResponse([{ artifacts: [{ ...artifact, revision: 'invalid' }], stale: false }])
					)
			)
		);
		const onEvent = vi.fn();
		await expect(
			createLocalClient('http://127.0.0.1:7731').watchArtifacts(
				{ userId: 'user-1', repositoryKey: 'repo-1', workspacePath: '/ws' },
				{ signal: new AbortController().signal, onEvent }
			)
		).rejects.toThrow();
		expect(onEvent).not.toHaveBeenCalled();
	});

	it('strips threadId from project-scoped artifacts and keeps stale snapshots', async () => {
		const threadArtifact = {
			...artifact,
			_id: 'artifact-2',
			scope: 'thread' as const,
			threadId: 'thread-1',
			localPath: 'notes.md'
		};
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						sseResponse([
							{
								artifacts: [{ ...artifact, threadId: 'thread-1' }, threadArtifact],
								stale: true,
								error: 'cloud lag'
							}
						]),
						{ status: 200 }
					)
			)
		);

		const events: unknown[] = [];
		await createLocalClient('http://127.0.0.1:7731').watchArtifacts(
			{
				userId: 'user-1',
				repositoryKey: 'repo-1',
				workspacePath: '/ws',
				threadId: 'thread-1'
			},
			{
				signal: new AbortController().signal,
				onEvent: (event) => {
					events.push(event);
				}
			}
		);

		expect(events).toEqual([
			{
				artifacts: [artifact, threadArtifact],
				stale: true,
				error: 'cloud lag'
			}
		]);
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

describe('transcript file upload', () => {
	it('posts the raw file through the authenticated helper', async () => {
		const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
		const fetch = vi.fn(async () =>
			Response.json({
				storageId: 'storage-1',
				name: 'notes.txt',
				mediaType: 'text/plain',
				size: 5,
				url: 'http://127.0.0.1:7731/files/notes.txt'
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
			storageId: 'storage-1',
			name: 'notes.txt',
			mediaType: 'text/plain',
			size: 5,
			url: 'http://127.0.0.1:7731/files/notes.txt'
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
				storageId: storageId('storage-1'),
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
				body: JSON.stringify({ userId: 'user-1', storageId: 'storage-1', threadId: 'thread-1' })
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
				storageId: storageId('storage-1')
			})
		).resolves.toBe(false);

		expect(fetch).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				body: JSON.stringify({ userId: 'user-1', storageId: 'storage-1' })
			})
		);
	});
});

describe('transcript attachment fetch', () => {
	it('posts storageId with the thread scope', async () => {
		const fetch = vi.fn(async () => new Response(new Blob(['png']), { status: 200 }));
		vi.stubGlobal('fetch', fetch);

		const blob = await createLocalClient('http://127.0.0.1:7731').fetchTranscriptAttachment({
			userId: 'user-1',
			threadId: threadRecordId('thread-1'),
			storageId: storageId('storage-1')
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
					storageId: 'storage-1'
				})
			})
		);
	});
});
