import type { Id } from '@convex/_generated/dataModel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { localSocket } from './socket';
import { stubWebSocket } from './socket-test-support';
import { LocalResponseError } from './transport';

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

// SAFETY: fixture strings are only compared as opaque Convex document ids.
const scope = { userId: 'user-1', threadId: 'thread-1' as Id<'threadRecords'> };

const staleSchema = z.object({ stale: z.boolean() });

describe('local socket', () => {
	it('shares one socket, delivers parsed events by subscription, and unsubscribes on abort', async () => {
		const sockets = stubWebSocket();
		const socket = localSocket('http://127.0.0.1:7001');
		const controller = new AbortController();
		const transcript = vi.fn();
		const live = vi.fn();

		const watching = socket.subscribe(
			{ kind: 'transcript', params: scope },
			staleSchema,
			controller.signal,
			transcript
		);

		void socket.subscribe(
			{ kind: 'liveCompletion', params: scope },
			staleSchema,
			controller.signal,
			live
		);

		expect(sockets).toHaveLength(1);
		expect(sockets[0].url).toBe('ws://127.0.0.1:7001/api/events');
		sockets[0].open();
		expect(sockets[0].sent).toEqual([
			{ type: 'subscribe', id: 1, topic: { kind: 'transcript', params: scope } },
			{ type: 'subscribe', id: 2, topic: { kind: 'liveCompletion', params: scope } }
		]);
		sockets[0].receive({ type: 'event', id: 1, data: { stale: false } });
		expect(transcript).toHaveBeenCalledWith({ stale: false });
		expect(live).not.toHaveBeenCalled();

		controller.abort();
		await watching;
		expect(sockets[0].sent.slice(2)).toEqual([
			{ type: 'unsubscribe', id: 1 },
			{ type: 'unsubscribe', id: 2 }
		]);
	});

	it('rejects server errors with their status and reconnects after a 401', async () => {
		const sockets = stubWebSocket();
		const socket = localSocket('http://127.0.0.1:7002');
		const signal = new AbortController().signal;
		const watching = socket.subscribe({ kind: 'authChanges' }, z.number(), signal, vi.fn());
		const other = socket.subscribe({ kind: 'packageUpdate' }, z.json(), signal, vi.fn());

		sockets[0].open();
		sockets[0].receive({ type: 'error', id: 1, status: 401, message: 'authentication required' });

		await expect(watching).rejects.toEqual(new LocalResponseError('authentication required', 401));
		await expect(other).rejects.toThrow('Lost the live connection');
		expect(sockets[0].readyState).toBe(WebSocket.CLOSED);

		void socket.subscribe({ kind: 'packageUpdate' }, z.json(), signal, vi.fn());
		expect(sockets).toHaveLength(2);
	});

	it('ends subscriptions when the socket drops and reconnects after a backoff', async () => {
		vi.useFakeTimers();
		const sockets = stubWebSocket();
		const socket = localSocket('http://127.0.0.1:7003');
		const signal = new AbortController().signal;
		const watching = socket.subscribe({ kind: 'authChanges' }, z.number(), signal, vi.fn());
		sockets[0].open();
		sockets[0].close();
		await expect(watching).rejects.toThrow('Lost the live connection');

		void socket.subscribe({ kind: 'authChanges' }, z.number(), signal, vi.fn());
		expect(sockets).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(500);
		expect(sockets).toHaveLength(2);
		sockets[1].open();
		expect(sockets[1].sent).toEqual([{ type: 'subscribe', id: 2, topic: { kind: 'authChanges' } }]);
	});
});
