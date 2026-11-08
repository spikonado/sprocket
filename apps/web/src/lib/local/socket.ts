import type {
	ArtifactsWatchRequest,
	SubscriptionHandlers,
	TranscriptScopeRequest,
	WorkspaceFileTarget
} from '$lib/types/sprocket';
import { z } from 'zod';
import { LocalResponseError } from './transport';

export type LocalTopic =
	| { kind: 'transcript'; params: TranscriptScopeRequest }
	| { kind: 'liveCompletion'; params: TranscriptScopeRequest }
	| { kind: 'artifacts'; params: ArtifactsWatchRequest }
	| { kind: 'commands'; params: TranscriptScopeRequest }
	| { kind: 'authChanges' }
	| { kind: 'browserStatus' }
	| { kind: 'packageUpdate' }
	| { kind: 'workspaceFiles'; params: { workspacePath: string } }
	| { kind: 'workspaceFile'; params: WorkspaceFileTarget };

const serverMessageSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('event'), id: z.number(), data: z.json() }),
	z.object({ type: z.literal('error'), id: z.number(), status: z.number(), message: z.string() }),
	z.object({ type: z.literal('end'), id: z.number() })
]);

export type LocalServerMessage = z.infer<typeof serverMessageSchema>;

type EventData = Extract<LocalServerMessage, { type: 'event' }>['data'];

type ClientMessage =
	{ type: 'subscribe'; id: number; topic: LocalTopic } | { type: 'unsubscribe'; id: number };

type Subscription = {
	topic: LocalTopic;
	sent: boolean;
	deliver: (data: EventData) => void;
	settle: (error?: Error) => void;
};

const RETRY_BASE_MS = 500;

const RETRY_MAX_MS = 15_000;

const STABLE_CONNECTION_MS = 10_000;

const RESUBSCRIBE_MS = 1_000;

/**
 * Owns the one socket to a Sprocket server and its reconnect backoff. A dropped
 * socket ends every subscription with an error. `subscribe` then subscribes
 * again, and the topic sends a fresh snapshot once the socket reconnects.
 */
class LocalSocket {
	#socket: WebSocket | null = null;
	#subscriptions = new Map<number, Subscription>();
	#nextId = 1;
	#failures = 0;
	#retryAt = 0;
	#retryTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly url: string) {}

	/** Keeps `topic` subscribed until `signal` aborts, reporting each interruption to `onError`. */
	async subscribe<T>(
		topic: LocalTopic,
		schema: z.ZodType<T>,
		{ signal, onEvent, onError }: SubscriptionHandlers<T>
	) {
		for (;;) {
			try {
				await this.subscribeOnce(topic, schema, signal, onEvent);
			} catch (error) {
				if (!signal.aborted) onError(error instanceof Error ? error : new Error(String(error)));
			}

			if (signal.aborted) return;
			await abortableDelay(RESUBSCRIBE_MS, signal);
		}
	}

	subscribeOnce<T>(
		topic: LocalTopic,
		schema: z.ZodType<T>,
		signal: AbortSignal,
		onEvent: (event: T) => void
	) {
		return new Promise<void>((resolve, reject) => {
			if (signal.aborted) return resolve();
			const id = this.#nextId++;

			const onAbort = () => {
				this.#end(id, true);
			};

			this.#subscriptions.set(id, {
				topic,
				sent: false,
				deliver: (data) => {
					onEvent(schema.parse(data));
				},
				settle: (error) => {
					signal.removeEventListener('abort', onAbort);

					if (error) reject(error);
					else resolve();
				}
			});
			signal.addEventListener('abort', onAbort, { once: true });
			this.#connect();
		});
	}

	#connect() {
		if (this.#socket) {
			if (this.#socket.readyState === WebSocket.OPEN) this.#flush();

			return;
		}

		if (this.#retryTimer) return;
		const wait = this.#retryAt - Date.now();

		if (wait > 0) {
			this.#retryTimer = setTimeout(() => {
				this.#retryTimer = null;

				if (this.#subscriptions.size) this.#connect();
			}, wait);

			return;
		}

		const socket = new WebSocket(this.url);
		let openedAt: number | null = null;
		this.#socket = socket;

		socket.onopen = () => {
			openedAt = Date.now();
			this.#flush();
		};

		socket.onmessage = (event) => {
			this.#receive(String(event.data));
		};

		socket.onclose = () => {
			if (this.#socket !== socket) return;
			this.#socket = null;

			this.#failures =
				openedAt !== null && Date.now() - openedAt >= STABLE_CONNECTION_MS ? 0 : this.#failures + 1;

			const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (this.#failures - 1));
			this.#retryAt = this.#failures ? Date.now() + delay * (0.5 + Math.random() / 2) : 0;
			this.#endAll();
		};
	}

	#endAll() {
		const lost = new Error('Lost the live connection to the Sprocket server.');

		for (const id of this.#subscriptions.keys()) this.#end(id, false, lost);
	}

	#flush() {
		for (const [id, subscription] of this.#subscriptions) {
			if (subscription.sent) continue;
			subscription.sent = true;
			this.#send({ type: 'subscribe', id, topic: subscription.topic });
		}
	}

	#receive(raw: string) {
		let message: LocalServerMessage;

		try {
			message = serverMessageSchema.parse(JSON.parse(raw));
		} catch {
			return;
		}

		const subscription = this.#subscriptions.get(message.id);

		if (!subscription) return;

		if (message.type === 'error') {
			this.#end(message.id, false, new LocalResponseError(message.message, message.status));

			// The server authenticates the cookie sent with the upgrade, so only a new socket picks up a fresh one.
			if (message.status === 401) this.#socket?.close();
		} else if (message.type === 'end') {
			this.#end(message.id, false);
		} else {
			try {
				subscription.deliver(message.data);
			} catch (error) {
				this.#end(message.id, true, error instanceof Error ? error : new Error(String(error)));
			}
		}
	}

	#end(id: number, unsubscribe: boolean, error?: Error) {
		const subscription = this.#subscriptions.get(id);

		if (!subscription) return;
		this.#subscriptions.delete(id);

		if (unsubscribe && subscription.sent) this.#send({ type: 'unsubscribe', id });
		subscription.settle(error);
	}

	#send(message: ClientMessage) {
		if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
	}
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
	return new Promise<void>((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener('abort', done);
			resolve();
		};

		const timer = setTimeout(done, milliseconds);
		signal.addEventListener('abort', done, { once: true });
	});
}

const sockets = new Map<string, LocalSocket>();

export function resetLocalSockets() {
	sockets.clear();
}

export function localSocket(baseUrl: string): LocalSocket {
	let socket = sockets.get(baseUrl);

	if (!socket) {
		const url = new URL('/api/events', baseUrl);
		url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
		socket = new LocalSocket(url.toString());
		sockets.set(baseUrl, socket);
	}

	return socket;
}
