import { useMemo } from 'react';
import type { Id } from '$convex/_generated/dataModel';
import { DisplayHistory, visibleDisplayMessages } from '$lib/project/display-history';
import { mergeLiveOverlays } from '$lib/project/transcript';
import { useStore, type Store } from '$lib/store';
import type {
	DesktopApi,
	LiveCompletionOverlay,
	TranscriptDisplayRow,
	TranscriptMessage
} from '$lib/types/sprocket';

export type TranscriptReplicaApi = Pick<
	DesktopApi,
	'fetchTranscriptDisplay' | 'watchTranscript' | 'watchLiveCompletion'
>;

type RunTiming = {
	runId: Id<'runs'>;
	startedAt: number;
	completedAt?: number;
} | null;

type WatchArgs = {
	api: TranscriptReplicaApi;
	userId: string;
	threadId: Id<'threadRecords'>;
	isCurrent: () => boolean;
};

export class TranscriptReplica implements Store<number> {
	messages: TranscriptDisplayRow[] = [];
	nextBefore: number | null = null;
	windowVersion = 0;
	stale = false;
	threadId: Id<'threadRecords'> | null = null;
	loading = false;
	error: string | null = null;
	loadingOlder = false;
	liveCompletion: LiveCompletionOverlay | null = null;
	pendingCompletions: LiveCompletionOverlay[] = [];

	#generation = 0;
	#history: DisplayHistory | null = null;
	#displayAbort: AbortController | null = null;
	#liveAbort: AbortController | null = null;
	#version = 0;
	readonly #listeners = new Set<() => void>();

	getSnapshot = () => this.#version;

	subscribe = (listener: () => void) => {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	};

	get overlays() {
		return [...this.pendingCompletions, ...(this.liveCompletion ? [this.liveCompletion] : [])];
	}

	selectThread(threadId: Id<'threadRecords'> | null) {
		this.#generation += 1;
		this.#displayAbort?.abort();
		this.#displayAbort = null;
		this.#liveAbort?.abort();
		this.#liveAbort = null;
		this.#history?.stop();
		this.#history = null;
		this.loadingOlder = false;
		this.threadId = threadId;
		this.liveCompletion = null;
		this.pendingCompletions = [];
		this.error = null;
		this.messages = [];
		this.nextBefore = null;
		this.windowVersion = 0;
		this.stale = false;
		this.loading = threadId !== null;
		this.#emit();
	}

	watchDisplay({ api, userId, threadId, isCurrent }: WatchArgs) {
		const ac = new AbortController();
		this.#displayAbort = ac;
		const generation = this.#generation;
		const history = new DisplayHistory(
			(request) => api.fetchTranscriptDisplay({ userId, threadId, ...request }, ac.signal),
			() => {
				if (ac.signal.aborted || generation !== this.#generation) return;
				this.messages = history.messages;
				this.nextBefore = history.nextBefore ?? null;
				this.windowVersion = history.windowVersion;
				this.stale = history.stale;
				this.loading = history.loading;
				this.loadingOlder = history.loadingOlder;
				this.error = history.error;
				const pendingCount = this.pendingCompletions.length;
				this.pendingCompletions = history
					.unpersisted(this.overlays)
					.filter((live) => live !== this.liveCompletion);
				if (this.pendingCompletions.length > 0 && this.pendingCompletions.length < pendingCount) {
					void history.refresh();
				}
				this.#emit();
			}
		);
		this.#history = history;
		void history.refresh();
		void this.#watchDisplayEvents(api, userId, threadId, history, ac, isCurrent);

		return () => {
			ac.abort();
			history.stop();
			if (this.#displayAbort === ac) this.#displayAbort = null;
			if (this.#history === history) this.#history = null;
		};
	}

	watchLiveCompletion({ api, userId, threadId, isCurrent }: WatchArgs) {
		const ac = new AbortController();
		this.#liveAbort = ac;
		void this.#watchLiveEvents(api, userId, threadId, ac, isCurrent);
		return () => {
			ac.abort();
			if (this.#liveAbort === ac) this.#liveAbort = null;
		};
	}

	syncOverlays(overlays: LiveCompletionOverlay[]) {
		this.#history?.setOverlays(overlays);
	}

	visibleMessages(args: {
		threadId: Id<'threadRecords'> | null;
		userId: string | null;
		run: RunTiming;
	}): TranscriptMessage[] {
		if (!args.threadId || !args.userId || this.threadId !== args.threadId) return [];
		const overlays = this.#history?.visibleOverlays(this.overlays) ?? [];
		const liveMessages = mergeLiveOverlays(
			overlays.filter((overlay) => overlay.threadId === args.threadId)
		);
		return [
			...visibleDisplayMessages(this.messages, overlays),
			...liveMessages.map((message) =>
				message.runId === args.run?.runId
					? {
							...message,
							runStartedAt: args.run.startedAt,
							runCompletedAt: args.run.completedAt
						}
					: message
			)
		];
	}

	async loadOlder() {
		await this.#history?.loadOlder();
	}

	#emit() {
		this.#version += 1;
		for (const listener of this.#listeners) listener();
	}

	async #watchDisplayEvents(
		api: TranscriptReplicaApi,
		userId: string,
		threadId: Id<'threadRecords'>,
		history: DisplayHistory,
		ac: AbortController,
		isCurrent: () => boolean
	) {
		while (!ac.signal.aborted) {
			try {
				await api.watchTranscript(
					{ userId, threadId },
					{
						signal: ac.signal,
						onEvent: (event) => {
							if (ac.signal.aborted || !isCurrent()) return;
							this.stale = event.stale;
							this.#emit();
							void history.refresh();
						}
					}
				);
			} catch {
				if (!ac.signal.aborted) {
					this.stale = true;
					this.#emit();
				}
			}
			if (!ac.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1_000));
		}
	}

	async #watchLiveEvents(
		api: TranscriptReplicaApi,
		userId: string,
		threadId: Id<'threadRecords'>,
		ac: AbortController,
		isCurrent: () => boolean
	) {
		while (!ac.signal.aborted) {
			try {
				await api.watchLiveCompletion(
					{ userId, threadId },
					{
						signal: ac.signal,
						onEvent: (event) => {
							if (ac.signal.aborted || !isCurrent()) return;
							const current = this.liveCompletion;
							if (
								current &&
								(event.eventType === 'cleared' || event.live.streamId !== current.streamId)
							) {
								if (this.#history?.unpersisted([current]).length) {
									this.pendingCompletions = [...this.pendingCompletions, current];
								}
								void this.#history?.refresh();
							}
							this.liveCompletion = event.eventType === 'updated' ? event.live : null;
							this.#emit();
						}
					}
				);
			} catch {
				if (ac.signal.aborted) return;
			}
			await abortableDelay(400, ac.signal);
		}
	}
}

export function useTranscriptReplica() {
	const replica = useMemo(() => new TranscriptReplica(), []);
	useStore(replica);
	return replica;
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
	if (signal.aborted) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, milliseconds);
		signal.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true }
		);
	});
}
