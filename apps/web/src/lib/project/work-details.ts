import type { TranscriptDetailCursor, TranscriptDisplayDetails } from '$lib/types/sprocket';

type Part = TranscriptDisplayDetails['parts'][number];
type Direction = 'older' | 'newer';

function partKey(part: Part) {
	return part.type === 'tool-call' || part.type === 'tool-result'
		? `${part.type}:${part.callId}`
		: `${part.type}:${part.turnId ?? ''}:${part.id}`;
}

export class WorkDetails {
	parts: Part[] = [];
	previousBefore: number | undefined;
	nextAfter: number | undefined;
	loading = false;
	indexing = false;
	stale = false;
	error = false;
	private start: TranscriptDetailCursor;
	private initialized = false;
	private stopped = false;
	private refreshPending = false;
	private failedDirection: Direction | undefined;
	private request: AbortController | undefined;
	private retry: ReturnType<typeof setTimeout> | undefined;

	constructor(
		latest: boolean,
		private load: (
			cursor: TranscriptDetailCursor,
			signal: AbortSignal
		) => Promise<TranscriptDisplayDetails>,
		private changed: () => void,
		private commit: (update: () => void, direction?: Direction) => Promise<void>
	) {
		this.start = latest ? { latest: true } : {};
	}

	stop() {
		this.stopped = true;
		this.request?.abort();
		clearTimeout(this.retry);
	}

	refresh() {
		if (this.loading) {
			this.refreshPending = true;
			return;
		}
		return this.fetch();
	}

	more(direction: Direction) {
		if (!this.initialized || this.loading || this.error || this.indexing) return;
		const cursor = direction === 'older' ? this.previousBefore : this.nextAfter;
		if (cursor === undefined) return;
		return this.fetch(direction);
	}

	retryFailed() {
		if (!this.loading) return this.fetch(this.failedDirection);
	}

	private async fetch(direction?: Direction) {
		if (this.stopped) return;
		clearTimeout(this.retry);
		const controller = new AbortController();
		this.request = controller;
		this.loading = true;
		this.indexing = false;
		this.error = false;
		this.failedDirection = direction;
		this.changed();
		try {
			let cursor =
				direction === 'older'
					? { before: this.previousBefore }
					: direction === 'newer'
						? { after: this.nextAfter }
						: this.start;
			const lastKey = this.parts.length ? partKey(this.parts[this.parts.length - 1]) : undefined;
			const pages: TranscriptDisplayDetails[] = [];
			while (true) {
				const page = await this.load(cursor, controller.signal);
				if (controller.signal.aborted) return;
				if (
					page.indexing ||
					(page.stale && !page.parts.length) ||
					(pages.length && page.revision < pages[pages.length - 1].revision)
				) {
					this.stale = page.stale;
					this.indexing = true;
					this.retry = setTimeout(() => void this.fetch(direction), 500);
					return;
				}
				if (
					(cursor.after !== undefined &&
						page.nextAfter !== undefined &&
						page.nextAfter <= cursor.after) ||
					(cursor.before !== undefined &&
						page.previousBefore !== undefined &&
						page.previousBefore >= cursor.before)
				) {
					throw new Error('Work detail cursor did not advance.');
				}
				pages.push(page);
				if (
					direction ||
					!lastKey ||
					page.parts.some((part) => partKey(part) === lastKey) ||
					page.nextAfter === undefined ||
					(this.nextAfter !== undefined && page.nextAfter >= this.nextAfter)
				)
					break;
				// A removed tail must not turn a refresh into a download of the whole section.
				if (pages.length > this.parts.length)
					throw new Error('Work detail range changed too much.');
				cursor = { after: page.nextAfter };
			}
			const first = pages[0];
			const last = pages[pages.length - 1];
			const added = pages.flatMap((page) => page.parts);
			await this.commit(() => {
				if (controller.signal.aborted) return;
				const combined =
					direction === 'older'
						? [...added, ...this.parts]
						: direction === 'newer'
							? [...this.parts, ...added]
							: added;
				const refreshed = new Map(added.map((part) => [partKey(part), part]));
				this.parts = [
					...new Map(
						combined.map((part) => [partKey(part), refreshed.get(partKey(part)) ?? part])
					).values()
				];
				if (direction !== 'newer') {
					this.previousBefore = first.previousBefore;
					this.start =
						first.previousBefore === undefined ? {} : { after: first.previousBefore - 1 };
				}
				if (direction !== 'older') this.nextAfter = last.nextAfter;
				this.initialized = true;
				this.stale = pages.some((page) => page.stale);
				this.changed();
			}, direction);
			if (!this.stopped && this.stale) this.retry = setTimeout(() => void this.refresh(), 2_000);
		} catch {
			if (!controller.signal.aborted) this.error = true;
		} finally {
			this.loading = false;
			if (!this.stopped) {
				this.changed();
				if (this.refreshPending) {
					this.refreshPending = false;
					void this.refresh();
				}
			}
		}
	}
}
