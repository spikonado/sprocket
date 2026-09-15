import type { Id } from '$convex/_generated/dataModel';
import { DisplayHistory, visibleDisplayMessages } from '$lib/project/display-history';
import { mergeLiveOverlays } from '$lib/project/transcript';
import type {
	DesktopApi,
	LiveCompletionOverlay,
	TranscriptDisplayRow,
	TranscriptMessage
} from '$lib/types/sprocket';

type RunTiming = {
	runId: Id<'runs'>;
	startedAt: number;
	completedAt?: number;
} | null;

type WatchArgs = {
	api: DesktopApi;
	userId: string;
	threadId: Id<'threadRecords'>;
	isCurrent: () => boolean;
};

export class TranscriptReplica {
	messages = $state.raw<TranscriptDisplayRow[]>([]);
	nextBefore = $state<number | null>(null);
	windowVersion = $state(0);
	stale = $state(false);
	threadId = $state<Id<'threadRecords'> | null>(null);
	loading = $state(false);
	error = $state<string | null>(null);
	loadingOlder = $state(false);
	liveCompletion = $state.raw<LiveCompletionOverlay | null>(null);
	pendingCompletions = $state.raw<LiveCompletionOverlay[]>([]);

	#generation = 0;
	#history = $state.raw<DisplayHistory | null>(null);
	#displayAbort: AbortController | null = null;
	#liveAbort: AbortController | null = null;

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

	async #watchDisplayEvents(
		api: DesktopApi,
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
							void history.refresh();
						}
					}
				);
			} catch {
				if (!ac.signal.aborted) this.stale = true;
			}
			if (!ac.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1_000));
		}
	}

	async #watchLiveEvents(
		api: DesktopApi,
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
