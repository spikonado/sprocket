import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { localSocket } from './socket';
import { stubWebSocket } from './socket-test-support';
import { LocalResponseError } from './transport';
import { fixtureId } from '$lib/convex-test-client';

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const scope = { userId: 'user-1', threadId: fixtureId<'threadRecords'>('thread-1') };

const staleSchema = z.object({ stale: z.boolean() });

describe('local socket', () => {
	it('shares one socket, delivers parsed events by subscription, and unsubscribes on abort', async () => {
		const sockets = stubWebSocket();
		const socket = localSocket('http://127.0.0.1:7001');
		const controller = new AbortController();
		const transcript = vi.fn();
		const live = vi.fn();

		const watching = socket.subscribeOnce(
			{ kind: 'transcript', params: scope },
			staleSchema,
			controller.signal,
			transcript
		);

		void socket.subscribeOnce(
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

	it('rejects server errors with their status and reconnects after a 401 with a backoff', async () => {
		vi.useFakeTimers();
		const sockets = stubWebSocket();
		const socket = localSocket('http://127.0.0.1:7002');
		const signal = new AbortController().signal;
		const watching = socket.subscribeOnce({ kind: 'authChanges' }, z.number(), signal, vi.fn());
		const other = socket.subscribeOnce({ kind: 'packageUpdate' }, z.json(), signal, vi.fn());

		sockets[0].open();
		sockets[0].receive({ type: 'error', id: 1, status: 401, message: 'authentication required' });

		await expect(watching).rejects.toEqual(new LocalResponseError('authentication required', 401));
		await expect(other).rejects.toThrow('Lost the live connection');
		expect(sockets[0].readyState).toBe(WebSocket.CLOSED);

		void socket.subscribeOnce({ kind: 'packageUpdate' }, z.json(), signal, vi.fn());
		expect(sockets).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(500);
		expect(sockets).toHaveLength(2);
	});

	it('ends subscriptions when the socket drops and reconnects after a backoff', async () => {
		vi.useFakeTimers();
		const sockets = stubWebSocket();
		const socket = localSocket('http://127.0.0.1:7003');
		const signal = new AbortController().signal;
		const watching = socket.subscribeOnce({ kind: 'authChanges' }, z.number(), signal, vi.fn());
		sockets[0].open();
		sockets[0].close();
		await expect(watching).rejects.toThrow('Lost the live connection');

		void socket.subscribeOnce({ kind: 'authChanges' }, z.number(), signal, vi.fn());
		expect(sockets).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(500);
		expect(sockets).toHaveLength(2);
		sockets[1].open();
		expect(sockets[1].sent).toEqual([{ type: 'subscribe', id: 2, topic: { kind: 'authChanges' } }]);
	});

	it('keeps a subscription across drops and reports each one until aborted', async () => {
		vi.useFakeTimers();
		const sockets = stubWebSocket();
		const socket = localSocket('http://127.0.0.1:7004');
		const controller = new AbortController();
		const onEvent = vi.fn();
		const onError = vi.fn();

		const watching = socket.subscribe({ kind: 'packageUpdate' }, z.json(), {
			signal: controller.signal,
			onEvent,
			onError
		});

		sockets[0].open();
		sockets[0].close();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(onError).toHaveBeenCalledWith(
			new Error('Lost the live connection to the Sprocket server.')
		);
		sockets[1].open();
		sockets[1].receive({ type: 'event', id: 2, data: 'snapshot' });
		expect(onEvent).toHaveBeenCalledWith('snapshot');

		controller.abort();
		await watching;
		expect(sockets[1].sent.at(-1)).toEqual({ type: 'unsubscribe', id: 2 });
		expect(onError).toHaveBeenCalledOnce();
	});
});
