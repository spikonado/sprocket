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
			{ authToken: 'token', userId: 'user-1', threadId: threadRecordId('thread-1') },
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
