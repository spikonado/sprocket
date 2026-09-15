import type { Doc, Id } from '$convex/_generated/dataModel';
import type { DesktopApi, ThreadCacheStatus, ThreadCacheUserRequest } from '$lib/types/sprocket';

type Dependencies = {
	getApi: () => DesktopApi | null;
	getUserId: () => string | null;
	getSelectedThreadId: () => Id<'threadRecords'> | null;
	onError: (message: string) => void;
};

export class ThreadCache {
	status = $state<ThreadCacheStatus>('loading');
	threads = $state.raw<Doc<'threadRecords'>[]>([]);

	#generation = 0;
	#pullGeneration = 0;

	constructor(private readonly dependencies: Dependencies) {}

	async pull(userId: string) {
		const api = this.dependencies.getApi();
		if (!api) return;
		const generation = ++this.#pullGeneration;
		const snapshot = await api.fetchThreadSnapshot({ userId });
		if (generation !== this.#pullGeneration || this.dependencies.getUserId() !== userId) return;
		this.threads = snapshot.threads;
		this.status = snapshot.status;
	}

	async register(selectedThreadId = this.dependencies.getSelectedThreadId()) {
		const api = this.dependencies.getApi();
		const userId = this.dependencies.getUserId();
		if (!api || !userId) return;
		const request: ThreadCacheUserRequest = { userId };
		if (selectedThreadId) request.selectedThreadId = selectedThreadId;
		const event = await api.registerThreadCache(request);
		if (this.dependencies.getUserId() !== userId) return;
		this.status = event.status;
		await this.pull(userId);
	}

	watch(userId: string) {
		const api = this.dependencies.getApi();
		if (!api) return;
		const generation = ++this.#generation;
		const ac = new AbortController();
		void (async () => {
			try {
				try {
					await this.register();
				} catch {
					await this.pull(userId);
				}
				if (generation !== this.#generation || ac.signal.aborted) return;
				await api.watchThreadCache(
					{ userId },
					{
						signal: ac.signal,
						onEvent: (event) => {
							if (generation !== this.#generation || this.dependencies.getUserId() !== userId) {
								return;
							}
							this.status = event.status;
							if (event.status === 'live' || event.status === 'reconnecting') {
								void this.pull(userId);
							}
						}
					}
				);
			} catch (error) {
				if (
					ac.signal.aborted ||
					generation !== this.#generation ||
					this.dependencies.getUserId() !== userId
				) {
					return;
				}
				this.status = 'error';
				this.dependencies.onError(
					error instanceof Error ? error.message : 'Could not sync threads.'
				);
			}
		})();
		return () => ac.abort();
	}

	markReconnecting() {
		this.status = 'reconnecting';
	}

	reset() {
		this.#pullGeneration += 1;
		this.status = 'loading';
		this.threads = [];
	}
}
