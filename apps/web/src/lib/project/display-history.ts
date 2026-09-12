import type {
	LiveCompletionOverlay,
	TranscriptDisplayPage,
	TranscriptDisplayRow,
	TranscriptChangeCursor
} from '$lib/types/sprocket';

type Stream = TranscriptDisplayPage['persistedStreams'][number];
type PageRequest = {
	before?: number;
	limit: number;
	changesAfter?: TranscriptChangeCursor;
	streams?: Stream[];
};

function streamKey(stream: { runId: string; streamId?: string }) {
	return `${stream.runId}:${stream.streamId}`;
}

export function visibleDisplayMessages(
	messages: TranscriptDisplayRow[],
	overlays: LiveCompletionOverlay[]
) {
	const liveRuns = new Set(overlays.map((overlay) => overlay.runId));
	return messages.filter((message) => !message.provisional || !liveRuns.has(message.runId));
}

export class DisplayHistory {
	messages: TranscriptDisplayRow[] = [];
	nextBefore: number | undefined;
	loading = true;
	loadingOlder = false;
	windowVersion = 0;
	stale = false;
	error: string | null = null;
	private stopped = false;
	private refreshing = false;
	private refreshPending = false;
	private olderPending = false;
	private retry: ReturnType<typeof setTimeout> | undefined;
	private rows = new Map<number, TranscriptDisplayRow>();
	private persistedStreams = new Set<string>();
	private checkedStreams = new Set<string>();
	private overlays: LiveCompletionOverlay[] = [];
	private revision = 0;
	private replicaId: string | undefined;
	private changesCursor: TranscriptChangeCursor | undefined;

	constructor(
		private fetchPage: (request: PageRequest) => Promise<TranscriptDisplayPage>,
		private changed: () => void
	) {}

	stop() {
		this.stopped = true;
		clearTimeout(this.retry);
	}

	unpersisted(overlays: LiveCompletionOverlay[]) {
		return overlays.filter((overlay) => !this.persistedStreams.has(streamKey(overlay)));
	}

	visibleOverlays(overlays: LiveCompletionOverlay[]) {
		return this.unpersisted(overlays).filter(
			(overlay) => !overlay.streamId || this.checkedStreams.has(streamKey(overlay))
		);
	}

	setOverlays(overlays: LiveCompletionOverlay[]) {
		const previous = new Set(this.overlays.map(streamKey));
		this.overlays = overlays;
		const retained = new Set(overlays.map(streamKey));
		for (const key of this.checkedStreams) if (!retained.has(key)) this.checkedStreams.delete(key);
		if (overlays.some((overlay) => !previous.has(streamKey(overlay)))) void this.refresh();
	}

	private streamRequest() {
		const unique = new Map<string, Stream>();
		for (const overlay of this.unpersisted(this.overlays)) {
			if (overlay.streamId)
				unique.set(streamKey(overlay), { runId: overlay.runId, streamId: overlay.streamId });
			if (unique.size === 64) break;
		}
		const streams = [...unique.values()];
		return streams.length ? { streams } : {};
	}

	async refresh() {
		if (this.stopped) return;
		if (this.refreshing) {
			this.refreshPending = true;
			return;
		}
		this.refreshing = true;
		let canLoadOlder = false;
		clearTimeout(this.retry);
		try {
			do {
				this.refreshPending = false;
				const streamRequest = this.streamRequest();
				const page = await this.fetchPage({
					limit: 12,
					changesAfter: this.changesCursor,
					...streamRequest
				});
				if (this.stopped) return;
				if (this.replicaId !== page.replicaId) {
					if (this.replicaId !== undefined) this.windowVersion += 1;
					this.rows.clear();
					this.messages = [];
					this.persistedStreams.clear();
					this.checkedStreams.clear();
					this.changesCursor = undefined;
					this.nextBefore = undefined;
					this.revision = 0;
					this.replicaId = page.replicaId;
					this.loading = true;
					this.changed();
				}
				if (page.indexing) {
					this.stale = page.stale;
					this.changed();
					this.retry = setTimeout(() => void this.refresh(), 500);
					break;
				}
				if (page.stale) this.retry = setTimeout(() => void this.refresh(), 2_000);
				if (page.revision < this.revision) {
					this.stale = page.stale;
					this.changed();
					break;
				}
				const lower = page.nextBefore ?? 0;
				const newest = this.messages.at(-1)?.sequence;
				if (newest !== undefined && newest < lower) {
					this.rows.clear();
					this.windowVersion += 1;
				}
				if (!this.rows.size || lower === 0 || lower <= (this.messages[0]?.sequence ?? 0))
					this.nextBefore = page.nextBefore;
				for (const number of this.rows.keys()) if (number >= lower) this.rows.delete(number);
				this.commit(page);
				for (const stream of streamRequest.streams ?? [])
					this.checkedStreams.add(streamKey(stream));
				this.changesCursor = page.changesCursor;
				this.refreshPending ||= page.moreChanges;
				this.refreshPending ||=
					page.persistedStreams.length > 0 &&
					this.unpersisted(this.overlays).some(
						(overlay) => overlay.streamId && !this.checkedStreams.has(streamKey(overlay))
					);
				canLoadOlder = true;
				this.loading = false;
				this.error = null;
				this.changed();
			} while (this.refreshPending && !this.stopped);
		} catch {
			if (!this.stopped) {
				this.stale = true;
				this.loading = false;
				this.error = this.messages.length ? null : 'Could not load conversation history.';
				this.changed();
				this.retry = setTimeout(() => void this.refresh(), 2_000);
			}
		} finally {
			this.refreshing = false;
			if (canLoadOlder && this.olderPending && !this.stopped) {
				this.olderPending = false;
				void this.loadOlder();
			}
		}
	}

	async loadOlder() {
		if (this.stopped || this.loadingOlder) return;
		if (this.refreshing) {
			this.olderPending = true;
			return;
		}
		if (this.nextBefore === undefined) return;
		const before = this.nextBefore;
		const version = this.windowVersion;
		this.loadingOlder = true;
		this.changed();
		try {
			const page = await this.fetchPage({ before, limit: 40, ...this.streamRequest() });
			if (this.stopped || version !== this.windowVersion) return;
			if (this.replicaId !== page.replicaId) {
				void this.refresh();
				return;
			}
			if (page.indexing) {
				this.olderPending = true;
				void this.refresh();
				return;
			}
			if (page.revision < this.revision) {
				this.stale = true;
				return;
			}
			if (page.persistedStreams.some((stream) => !this.persistedStreams.has(streamKey(stream)))) {
				this.olderPending = true;
				void this.refresh();
				return;
			}
			if (page.nextBefore !== undefined && page.nextBefore >= before)
				throw new Error('History cursor did not advance.');
			this.commit(page);
			this.nextBefore = page.nextBefore;
		} catch {
			if (!this.stopped && version === this.windowVersion) this.stale = true;
		} finally {
			this.loadingOlder = false;
			if (!this.stopped) this.changed();
		}
	}

	private commit(page: TranscriptDisplayPage) {
		const previous = new Map(this.messages.map((message) => [message.id, message]));
		const firstLoaded = this.rows.size ? this.messages[0]?.sequence : undefined;
		for (const change of page.changes) {
			const existing = previous.get(change.id);
			if (!existing) {
				if (change.row && firstLoaded !== undefined && change.row.sequence >= firstLoaded)
					this.rows.set(change.row.sequence, change.row);
				continue;
			}
			if (!change.row) this.rows.delete(existing.sequence);
			else if (change.row.revision > existing.revision)
				this.rows.set(change.row.sequence, change.row);
		}
		for (const row of page.rows) {
			const existing = this.rows.get(row.sequence) ?? previous.get(row.id);
			this.rows.set(row.sequence, existing && existing.revision >= row.revision ? existing : row);
		}
		const messages = [...this.rows.entries()]
			.sort(([left], [right]) => left - right)
			.map(([, message]) => message);
		if (
			messages.length !== this.messages.length ||
			messages.some((message, index) => message !== this.messages[index])
		)
			this.messages = messages;
		this.stale = page.stale;
		this.revision = Math.max(this.revision, page.revision);
		for (const stream of page.persistedStreams)
			this.persistedStreams.add(`${stream.runId}:${stream.streamId}`);
		while (this.persistedStreams.size > 256) {
			const oldest = this.persistedStreams.values().next().value;
			if (oldest === undefined) break;
			this.persistedStreams.delete(oldest);
		}
	}
}
