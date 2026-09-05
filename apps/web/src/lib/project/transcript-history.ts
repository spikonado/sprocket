import type { LocalTranscriptPage, ThreadMessage } from '$lib/types/sprocket';
import { mergeTranscriptMessages } from '$lib/project/transcript';

type PageRequest = { before?: number; limit: number };

export class TranscriptHistory {
	messages: ThreadMessage[] = [];
	nextBefore: number | undefined;
	loading = true;
	loadingOlder = false;
	stale = false;
	error: string | null = null;
	private stopped = false;
	private refreshing = false;
	private refreshPending = false;
	private prefetchTimer: ReturnType<typeof setTimeout> | undefined;
	private refreshRetryTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private fetchPage: (request: PageRequest) => Promise<LocalTranscriptPage>,
		private changed: () => void
	) {}

	stop() {
		this.stopped = true;
		clearTimeout(this.prefetchTimer);
		clearTimeout(this.refreshRetryTimer);
	}

	private prefetch(delay = 25) {
		clearTimeout(this.prefetchTimer);
		if (!this.stopped && this.nextBefore !== undefined) {
			this.prefetchTimer = setTimeout(() => void this.loadOlder(), delay);
		}
	}

	async refresh() {
		if (this.stopped) return;
		if (this.refreshing) {
			this.refreshPending = true;
			return;
		}
		this.refreshing = true;
		clearTimeout(this.refreshRetryTimer);
		try {
			do {
				this.refreshPending = false;
				const newestSource = this.messages.at(-1)?.sourceNumbers?.[0];
				let incoming: ThreadMessage[] = [];
				let newestPage: LocalTranscriptPage | undefined;
				let before: number | undefined;
				do {
					const page = await this.fetchPage({ before, limit: this.loading ? 12 : 40 });
					if (this.stopped) return;
					newestPage ??= page;
					incoming = mergeTranscriptMessages(incoming, page.messages);
					if (page.nextBefore === undefined) break;
					if (before !== undefined && page.nextBefore >= before) {
						throw new Error('Transcript history cursor did not advance');
					}
					before = page.nextBefore;
				} while (newestSource !== undefined && before > newestSource);
				if (this.messages.length === 0) this.nextBefore = newestPage.nextBefore;
				this.messages = mergeTranscriptMessages(this.messages, incoming);
				this.stale = newestPage.stale;
				this.error = null;
				this.loading = false;
				this.changed();
			} while (this.refreshPending && !this.stopped);
		} catch {
			if (!this.stopped) {
				this.stale = true;
				this.loading = false;
				this.error = this.messages.length ? null : 'Could not load conversation history.';
				this.changed();
				this.refreshRetryTimer = setTimeout(() => void this.refresh(), 2_000);
			}
		} finally {
			this.refreshing = false;
			this.prefetch();
		}
	}

	async loadOlder() {
		if (this.stopped || this.loadingOlder || this.nextBefore === undefined) return;
		if (this.refreshing) {
			this.prefetch();
			return;
		}
		const before = this.nextBefore;
		this.loadingOlder = true;
		this.changed();
		let retryDelay = 25;
		try {
			const page = await this.fetchPage({ before, limit: 40 });
			if (this.stopped) return;
			if (page.nextBefore !== undefined && page.nextBefore >= before) {
				throw new Error('Transcript history cursor did not advance');
			}
			this.messages = mergeTranscriptMessages(this.messages, page.messages);
			this.nextBefore = page.nextBefore;
			this.stale = page.stale;
		} catch {
			this.stale = true;
			retryDelay = 2_000;
		} finally {
			this.loadingOlder = false;
			if (!this.stopped) {
				this.changed();
				this.prefetch(retryDelay);
			}
		}
	}

	applyDetails(message: ThreadMessage) {
		if (this.stopped) return;
		this.messages = mergeTranscriptMessages(this.messages, [message]);
		this.changed();
	}
}
