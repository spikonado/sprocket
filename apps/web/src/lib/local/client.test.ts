import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '$convex/_generated/dataModel';
import {
	createLocalClient,
	readWorkspaceLaunchFromHash,
	workspaceLaunchHash
} from '$lib/local/client';

function threadRecordId(value: string): Id<'threadRecords'> {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return value as Id<'threadRecords'>;
}

function runId(value: string): Id<'runs'> {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return value as Id<'runs'>;
}

afterEach(() => {
	vi.unstubAllGlobals();
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
