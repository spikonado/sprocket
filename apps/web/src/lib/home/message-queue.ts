import type { Id } from '@convex/_generated/dataModel';
import { isLifecycleInProgress, type SelectedThreadLifecycle } from '@convex/lib/runCancellation';
import { createStore } from '$lib/store';
import type { AgentRunRequest, AgentRunStart, DesktopApi } from '$lib/types/sprocket';

type QueueRequest = AgentRunRequest & { threadId: Id<'threadRecords'> };

export type QueuedMessage = {
	id: string;
	request: QueueRequest;
	attachmentNames: string[];
	status: 'queued' | 'sending' | 'failed';
	error?: string;
};

type QueueContext = {
	userId: string;
	api: Pick<DesktopApi, 'runAgent' | 'discardTranscriptAttachment'>;
	watchLifecycle: (
		threadId: Id<'threadRecords'>,
		onUpdate: (lifecycle: SelectedThreadLifecycle) => void,
		onError: (error: Error) => void
	) => () => void;
	onStarted: (started: AgentRunStart) => void;
};

export class MessageQueue {
	readonly #store = createStore<QueuedMessage[]>([]);
	getSnapshot = this.#store.getSnapshot;
	subscribe = this.#store.subscribe;
	#context: QueueContext | null = null;
	readonly #watches = new Map<Id<'threadRecords'>, { stop: () => void }>();
	readonly #launching = new Set<Id<'threadRecords'>>();
	readonly #lifecycles = new Map<Id<'threadRecords'>, SelectedThreadLifecycle>();
	readonly #awaitingRuns = new Map<Id<'threadRecords'>, Id<'runs'> | null>();

	setContext(context: QueueContext | null) {
		for (const watch of this.#watches.values()) watch.stop();
		this.#watches.clear();
		this.#lifecycles.clear();
		this.#context = context;
		this.#syncWatches();
	}

	enqueue(request: QueueRequest, attachmentNames: string[]) {
		this.#store.update((messages) => [
			...messages,
			{
				id: request.submissionId,
				request: { ...request, storageIds: [...request.storageIds] },
				attachmentNames: [...attachmentNames],
				status: 'queued'
			}
		]);
		this.#syncWatches();

		void this.#drain(request.threadId);
	}

	retry(id: string) {
		const message = this.getSnapshot().find((entry) => entry.id === id);

		if (!message || message.status !== 'failed') return;
		this.#update(id, { status: 'queued', error: undefined });
		void this.#drain(message.request.threadId);
	}

	remove(id: string) {
		const message = this.getSnapshot().find((entry) => entry.id === id);

		if (!message || message.status === 'sending') return;
		this.#store.update((messages) => messages.filter((entry) => entry.id !== id));
		const context = this.#context;

		if (context?.userId === message.request.userId) {
			for (const storageId of message.request.storageIds) {
				void context.api
					.discardTranscriptAttachment({
						userId: message.request.userId,
						threadId: message.request.threadId,
						storageId
					})
					.catch(() => {});
			}
		}

		this.#syncWatches();
		void this.#drain(message.request.threadId);
	}

	#update(id: string, patch: Partial<Pick<QueuedMessage, 'status' | 'error'>>) {
		this.#store.update((messages) =>
			messages.map((message) => (message.id === id ? { ...message, ...patch } : message))
		);
	}

	#syncWatches() {
		const context = this.#context;

		const threads = new Set(
			this.getSnapshot()
				.filter((message) => message.request.userId === context?.userId)
				.map((message) => message.request.threadId)
		);

		for (const [threadId, watch] of this.#watches) {
			if (threads.has(threadId)) continue;
			watch.stop();
			this.#watches.delete(threadId);
			this.#lifecycles.delete(threadId);
			this.#awaitingRuns.delete(threadId);
		}

		if (!context) return;

		for (const threadId of threads) {
			if (this.#watches.has(threadId)) continue;

			const watch = { stop: () => {} };
			this.#watches.set(threadId, watch);

			const stop = context.watchLifecycle(
				threadId,
				(lifecycle) => {
					if (this.#context !== context || this.#watches.get(threadId) !== watch) return;
					this.#lifecycles.set(threadId, lifecycle);
					void this.#drain(threadId);
				},
				(error) => {
					if (this.#context !== context || this.#watches.get(threadId) !== watch) return;
					this.#lifecycles.delete(threadId);
					const head = this.#head(threadId);

					if (head?.status === 'queued') {
						this.#update(head.id, { status: 'failed', error: error.message });
					}
				}
			);

			watch.stop = stop;

			if (this.#watches.get(threadId) !== watch) stop();
		}
	}

	#head(threadId: Id<'threadRecords'>) {
		return this.getSnapshot().find(
			(message) =>
				message.request.threadId === threadId && message.request.userId === this.#context?.userId
		);
	}

	async #drain(threadId: Id<'threadRecords'>) {
		const context = this.#context;
		const head = this.#head(threadId);

		if (!context || !head || head.status !== 'queued' || this.#launching.has(threadId)) return;

		const lifecycle = this.#lifecycles.get(threadId);

		if (!lifecycle || isLifecycleInProgress(lifecycle.phase)) return;

		if (
			this.#awaitingRuns.has(threadId) &&
			(lifecycle.run?.runId ?? null) === this.#awaitingRuns.get(threadId)
		) {
			return;
		}

		this.#awaitingRuns.delete(threadId);
		this.#launching.add(threadId);
		this.#update(head.id, { status: 'sending', error: undefined });

		try {
			const started = await context.api.runAgent(head.request);
			this.#store.update((messages) => messages.filter((message) => message.id !== head.id));

			if (lifecycle.run?.runId !== started.runId) {
				this.#awaitingRuns.set(threadId, lifecycle.run?.runId ?? null);
			}

			if (this.#context?.userId === context.userId) context.onStarted(started);
		} catch (error) {
			this.#update(head.id, {
				status: 'failed',
				error: error instanceof Error ? error.message : 'Failed to send queued message.'
			});
		} finally {
			this.#launching.delete(threadId);
			this.#syncWatches();
			void this.#drain(threadId);
		}
	}
}
