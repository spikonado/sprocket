import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '$convex/_generated/dataModel';
import {
	createLocalClient,
	ensureLocalSession,
	readWorkspaceLaunchFromHash,
	transcriptUploadPath,
	workspaceLaunchHash
} from '$lib/local/client';

function threadRecordId(value: string): Id<'threadRecords'> {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return value as Id<'threadRecords'>;
}

function imageUploadId(value: string): Id<'imageUploads'> {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return value as Id<'imageUploads'>;
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
	it('uses the message endpoint without changing the legacy parts endpoint', async () => {
		const fetch = vi.fn(async () =>
			Response.json({
				threadId: 'thread-1',
				totalParts: 0,
				historyFromNumber: 0,
				stale: false,
				messages: []
			})
		);
		vi.stubGlobal('fetch', fetch);
		const page = await createLocalClient('http://127.0.0.1:7731').fetchTranscriptPage({
			userId: 'user-1',
			threadId: threadRecordId('thread-1'),
			limit: 12
		});
		expect(page.messages).toEqual([]);
		expect(fetch).toHaveBeenCalledWith(
			'http://127.0.0.1:7731/api/transcript/messages',
			expect.objectContaining({ method: 'POST' })
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
	it('parses snapshot threads and watch status events', async () => {
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
					serviceTier: 'standard',
					lastMessageAt: 10,
					status: 'completed'
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
		expect(await client.fetchThreadSnapshot({ userId: 'user-1' })).toEqual({
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
					serviceTier: 'standard',
					lastMessageAt: 10,
					status: 'completed'
				}
			],
			status: 'live',
			lastSyncedAt: 20
		});

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
	it('encodes query values and omits threadId until one exists', () => {
		expect(
			transcriptUploadPath({
				userId: 'user/1',
				name: 'spec & notes.pdf'
			})
		).toBe('/api/transcript/upload?userId=user%2F1&name=spec%20%26%20notes.pdf');
		expect(
			transcriptUploadPath({
				userId: 'user-1',
				name: 'notes.txt',
				threadId: 'thread/1'
			})
		).toBe('/api/transcript/upload?userId=user-1&name=notes.txt&threadId=thread%2F1');
	});

	it('posts the raw file through the authenticated helper', async () => {
		const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
		const fetch = vi.fn(async () =>
			Response.json({
				imageUploadId: 'upload-1',
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
			imageUploadId: 'upload-1',
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
				imageUploadId: imageUploadId('upload-1'),
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
				body: JSON.stringify({ userId: 'user-1', imageUploadId: 'upload-1', threadId: 'thread-1' })
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
				imageUploadId: imageUploadId('upload-1')
			})
		).resolves.toBe(false);

		expect(fetch).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				body: JSON.stringify({ userId: 'user-1', imageUploadId: 'upload-1' })
			})
		);
	});
});
