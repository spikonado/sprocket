import type { LocalTranscriptPage, LocalTranscriptPart, ThreadMessage } from '$lib/types/sprocket';
import { assembleTranscriptParts } from './transcript-parts';

type PageRequest = { before?: number; limit: number };

const RECENT_PAGE_LIMIT = 12;
const OLDER_PAGE_LIMIT = 40;
const REFRESH_RETRY_MS = 2_000;

function sameMessage(left: ThreadMessage, right: ThreadMessage): boolean {
	return (
		left._id === right._id &&
		left.text === right.text &&
		left.detailsLoaded === right.detailsLoaded &&
		JSON.stringify(left.sourceNumbers) === JSON.stringify(right.sourceNumbers) &&
		JSON.stringify(left.streamIds) === JSON.stringify(right.streamIds) &&
		JSON.stringify(left.parts) === JSON.stringify(right.parts)
	);
}

function stabilizeMessages(previous: ThreadMessage[], next: ThreadMessage[]): ThreadMessage[] {
	const byId = new Map(previous.map((message) => [message._id, message]));
	return next.map((message) => {
		const current = byId.get(message._id);
		return current && sameMessage(current, message) ? current : message;
	});
}

export class TranscriptHistory {
	messages: ThreadMessage[] = [];
	nextBefore: number | undefined;
	loading = true;
	loadingOlder = false;
	stale = false;
	error: string | null = null;
	private parts = new Map<number, LocalTranscriptPart>();
	private stopped = false;
	private refreshing = false;
	private refreshPending = false;
	private loadOlderPending = false;
	private refreshRetryTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private fetchPage: (request: PageRequest) => Promise<LocalTranscriptPage>,
		private changed: () => void
	) {}

	stop() {
		this.stopped = true;
		this.loadOlderPending = false;
		clearTimeout(this.refreshRetryTimer);
	}

	detailsNumbers(message: ThreadMessage): number[] {
		return (message.sourceNumbers ?? []).filter((number) => {
			const part = this.parts.get(number);
			return part?.message != null && part.message.detailsLoaded !== true;
		});
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
				const newestLoaded = this.newestLoadedNumber();
				const incoming: LocalTranscriptPart[] = [];
				let newestPage: LocalTranscriptPage | undefined;
				let before: number | undefined;
				do {
					const page = await this.fetchPage({ before, limit: RECENT_PAGE_LIMIT });
					if (this.stopped) return;
					newestPage ??= page;
					incoming.push(...page.parts);
					if (page.nextBefore === undefined) break;
					if (before !== undefined && page.nextBefore >= before) {
						throw new Error('Transcript history cursor did not advance');
					}
					before = page.nextBefore;
				} while (newestLoaded !== undefined && before !== undefined && before > newestLoaded);
				if (!newestPage) return;
				if (this.parts.size === 0) this.nextBefore = newestPage.nextBefore;
				this.commit(incoming);
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
				this.refreshRetryTimer = setTimeout(() => void this.refresh(), REFRESH_RETRY_MS);
			}
		} finally {
			this.refreshing = false;
			if (this.loadOlderPending && !this.stopped) {
				this.loadOlderPending = false;
				void this.loadOlder();
			}
		}
	}

	async loadOlder() {
		if (this.stopped || this.loadingOlder) return;
		if (this.refreshing) {
			this.loadOlderPending = true;
			return;
		}
		if (this.nextBefore === undefined) return;
		const before = this.nextBefore;
		this.loadingOlder = true;
		this.changed();
		try {
			const page = await this.fetchPage({ before, limit: OLDER_PAGE_LIMIT });
			if (this.stopped) return;
			if (page.nextBefore !== undefined && page.nextBefore >= before) {
				throw new Error('Transcript history cursor did not advance');
			}
			this.commit(page.parts);
			this.nextBefore = page.nextBefore;
			this.stale = page.stale;
		} catch {
			if (!this.stopped) this.stale = true;
		} finally {
			this.loadingOlder = false;
			if (!this.stopped) this.changed();
		}
	}

	applyDetails(parts: LocalTranscriptPart[]) {
		if (this.stopped) return;
		this.commit(parts.filter((part) => this.parts.has(part.number)));
		this.changed();
	}

	private newestLoadedNumber(): number | undefined {
		let newest: number | undefined;
		for (const number of this.parts.keys()) {
			newest = newest === undefined ? number : Math.max(newest, number);
		}
		return newest;
	}

	private ingest(parts: LocalTranscriptPart[]) {
		for (const part of parts) {
			const current = this.parts.get(part.number);
			if (current?.message?.detailsLoaded === true && part.message?.detailsLoaded !== true) {
				continue;
			}
			this.parts.set(part.number, part);
		}
	}

	private commit(parts: LocalTranscriptPart[]) {
		this.ingest(parts);
		this.messages = stabilizeMessages(
			this.messages,
			assembleTranscriptParts([...this.parts.values()])
		);
	}
}
