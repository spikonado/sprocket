import type {
	LiveCompletionOverlay,
	ThreadMessage,
	TranscriptDisplayPage,
	TranscriptDisplayRow,
	TranscriptChangeCursor
} from '$lib/types/sprocket';

type PageRequest = { before?: number; limit: number; changesAfter?: TranscriptChangeCursor };

export function visibleDisplayMessages(
	messages: ThreadMessage[],
	overlays: LiveCompletionOverlay[]
) {
	const liveRuns = new Set(overlays.map((overlay) => overlay.runId));
	return messages.filter(
		(message) => !message.displayRow?.provisional || !liveRuns.has(message.runId)
	);
}

function messageForRow(row: TranscriptDisplayRow): ThreadMessage {
	return {
		_id: row.id,
		threadId: row.threadId,
		runId: row.runId,
		userId: '',
		type: row.kind === 'prompt' ? 'prompt' : 'response',
		text: row.text ?? '',
		attachments: (row.attachments ?? []).map((attachment) => ({ ...attachment, url: null })),
		parts:
			row.kind === 'text'
				? [{ type: 'text', id: row.id, text: row.text ?? '', startedAt: row.startedAt }]
				: [],
		runStatus: 'completed',
		runStartedAt: 0,
		displayRow: row
	};
}

export class DisplayHistory {
	messages: ThreadMessage[] = [];
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
	private rows = new Map<number, ThreadMessage>();
	private persistedStreams = new Set<string>();
	private revision = 0;
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
		return overlays.filter(
			(overlay) => !this.persistedStreams.has(`${overlay.runId}:${overlay.streamId}`)
		);
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
				const page = await this.fetchPage({
					limit: 12,
					changesAfter: this.changesCursor
				});
				if (this.stopped) return;
				if (page.indexing) {
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
				const newest = this.messages.at(-1)?.displayRow?.sequence;
				if (newest !== undefined && newest < lower) {
					this.rows.clear();
					this.windowVersion += 1;
				}
				if (!this.rows.size || lower === 0) this.nextBefore = page.nextBefore;
				for (const number of this.rows.keys()) if (number >= lower) this.rows.delete(number);
				this.commit(page);
				this.changesCursor = page.changesCursor;
				this.refreshPending ||= page.moreChanges;
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
			const page = await this.fetchPage({ before, limit: 40 });
			if (this.stopped || version !== this.windowVersion) return;
			if (page.indexing) {
				this.olderPending = true;
				void this.refresh();
				return;
			}
			if (page.revision < this.revision) {
				this.stale = true;
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
		const previous = new Map(this.messages.map((message) => [message._id, message]));
		for (const change of page.changes) {
			const existing = previous.get(change.id);
			if (!existing?.displayRow) continue;
			if (!change.row) this.rows.delete(existing.displayRow.sequence);
			else if (change.row.revision > existing.displayRow.revision)
				this.rows.set(change.row.sequence, messageForRow(change.row));
		}
		for (const row of page.rows) {
			const existing = this.rows.get(row.sequence) ?? previous.get(row.id);
			this.rows.set(
				row.sequence,
				existing?.displayRow && existing.displayRow.revision >= row.revision
					? existing
					: messageForRow(row)
			);
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
