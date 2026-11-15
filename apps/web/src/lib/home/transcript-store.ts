import { useCallback, useState, useSyncExternalStore } from 'react';
import type { Id } from '@convex/_generated/dataModel';
import { useStore, type Store } from '$lib/store';
import type {
	LocalApi,
	TranscriptEvent,
	TranscriptRow,
	TranscriptSnapshot,
	TranscriptScopeRequest
} from '$lib/types/sprocket';

export type TranscriptStoreApi = Pick<
	LocalApi,
	| 'fetchTranscriptRows'
	| 'fetchTranscriptRow'
	| 'watchTranscript'
	| 'watchTranscriptWork'
	| 'watchTranscriptItem'
>;

type Connection = {
	api: TranscriptStoreApi;
	scope: TranscriptScopeRequest;
	abort: AbortController;
	isCurrent: () => boolean;
};

type Interest = {
	kind: 'work' | 'item';
	rowId: string;
	users: number;
	rows: Map<string, TranscriptRow>;
	abort: AbortController | null;
};

type Target = 'thread' | Interest;

type Append = Extract<
	Extract<TranscriptEvent, { type: 'batch' }>['updates'][number],
	{ type: 'append' }
>;

type Repair = { abort: AbortController; appends: Append[] };

const NO_ROWS: readonly string[] = [];

export class TranscriptStore implements Store<number> {
	rowIds: readonly string[] = NO_ROWS;
	threadId: Id<'threadRecords'> | null = null;
	nextBefore: number | null = null;
	loading = false;
	loadingOlder = false;
	stale = false;
	error: string | null = null;

	#window = new Map<string, TranscriptRow>();
	#workRows = new Map<string, TranscriptRow>();
	#workIds = new Map<string, readonly string[]>();
	#expanded = new Map<string, boolean>();
	#rowListeners = new Map<string, Set<() => void>>();
	#workListeners = new Map<string, Set<() => void>>();
	#listeners = new Set<() => void>();
	#interests = new Map<string, Interest>();
	#repairs = new Map<Target, Map<string, Repair>>();
	#connection: Connection | null = null;
	#threadAbort: AbortController | null = null;
	#ready = false;
	#generation = 0;
	#version = 0;

	getSnapshot = () => this.#version;
	getRowIds = () => this.rowIds;

	subscribe = (listener: () => void) => {
		this.#listeners.add(listener);

		return () => {
			this.#listeners.delete(listener);
		};
	};

	getRow = (rowId: string, detail = false) =>
		(detail ? this.#interests.get(`item:${rowId}`)?.rows.get(rowId) : undefined) ??
		this.#window.get(rowId) ??
		this.#workRows.get(rowId);

	getWorkIds = (rowId: string) => this.#workIds.get(rowId) ?? NO_ROWS;
	isExpanded = (rowId: string, defaultValue = false) => this.#expanded.get(rowId) ?? defaultValue;

	setExpanded(rowId: string, expanded: boolean) {
		this.#expanded.set(rowId, expanded);
		this.#emitRow(rowId);
	}

	subscribeRow = (rowId: string, listener: () => void) =>
		listen(this.#rowListeners, rowId, listener);

	subscribeWork = (rowId: string, listener: () => void) =>
		listen(this.#workListeners, rowId, listener);

	selectThread(threadId: Id<'threadRecords'> | null) {
		this.#stop();
		this.threadId = threadId;
		this.#expanded.clear();
		this.loading = threadId !== null;
		this.#emit();
	}

	watch({
		api,
		userId,
		threadId,
		isCurrent
	}: {
		api: TranscriptStoreApi;
		userId: string;
		threadId: Id<'threadRecords'>;
		isCurrent: () => boolean;
	}) {
		this.#stop();
		this.threadId = threadId;

		const connection: Connection = {
			api,
			scope: { userId, threadId },
			abort: new AbortController(),
			isCurrent
		};

		this.#connection = connection;
		this.loading = true;
		this.#emit();
		this.#startThread(connection);

		return () => {
			if (this.#connection === connection) this.#stop();
		};
	}

	openWork = (rowId: string) => this.#open('work', rowId);
	openItem = (rowId: string) => this.#open('item', rowId);

	async loadOlder() {
		const connection = this.#connection;
		const before = this.nextBefore;

		if (!connection || !this.#ready || before === null || this.loadingOlder) return;
		const generation = this.#generation;
		this.loadingOlder = true;
		this.error = null;
		this.#emit();

		try {
			const page = await connection.api.fetchTranscriptRows(
				{ ...connection.scope, before },
				connection.abort.signal
			);

			if (!this.#current(connection) || generation !== this.#generation) return;
			this.#window = new Map([...page.rows.map((row) => [row.id, row] as const), ...this.#window]);
			this.#refreshRowIds();
			this.nextBefore = page.nextBefore;

			for (const row of page.rows) this.#emitRow(row.id);
			this.#startThread(connection, page.nextBefore ?? 0);
		} catch (error) {
			if (this.#current(connection) && generation === this.#generation) {
				this.error = error instanceof Error ? error.message : 'Could not load older history.';
			}
		} finally {
			if (this.#current(connection) && generation === this.#generation) {
				this.loadingOlder = false;
				this.#emit();
			}
		}
	}

	#current(connection: Connection) {
		return (
			this.#connection === connection && !connection.abort.signal.aborted && connection.isCurrent()
		);
	}

	#startThread(connection: Connection, before?: number) {
		this.#threadAbort?.abort();
		this.#cancelRepairs('thread');
		const abort = new AbortController();
		this.#threadAbort = abort;
		void this.#watchTarget(connection, 'thread', abort, before);
	}

	async #watchTarget(
		connection: Connection,
		target: Target,
		abort: AbortController,
		before?: number
	) {
		let retryMs = 1_000;

		while (!abort.signal.aborted && this.#current(connection)) {
			const signal = AbortSignal.any([connection.abort.signal, abort.signal]);

			const onEvent = (event: TranscriptEvent) => {
				if (signal.aborted || !this.#current(connection)) return;

				if (event.type === 'snapshot') {
					retryMs = 1_000;
					this.#replace(target, event);
				} else this.#applyBatch(target, event);
			};

			try {
				if (target === 'thread') {
					const request: TranscriptScopeRequest & { before?: number } = { ...connection.scope };

					if (before !== undefined) request.before = before;

					await connection.api.watchTranscript(request, { signal, onEvent });
				} else {
					const watch =
						target.kind === 'work'
							? connection.api.watchTranscriptWork
							: connection.api.watchTranscriptItem;

					await watch({ ...connection.scope, rowId: target.rowId }, { signal, onEvent });
				}
			} catch {}

			if (abort.signal.aborted || !this.#current(connection)) return;
			this.#reset(target);
			before = undefined;
			await delay(abort.signal, retryMs);
			retryMs = Math.min(retryMs * 2, 10_000);
		}
	}

	#replace(target: Target, snapshot: TranscriptSnapshot) {
		this.#cancelRepairs(target);

		if (target === 'thread') {
			const previousIds = this.rowIds;

			if (
				this.nextBefore !== snapshot.nextBefore ||
				previousIds.length !== snapshot.rows.length ||
				snapshot.rows.some((row, index) => row.id !== previousIds[index])
			) {
				this.#generation += 1;
				this.loadingOlder = false;
			}

			this.nextBefore = snapshot.nextBefore;
			this.#window = new Map(snapshot.rows.map((row) => [row.id, row]));
			this.#refreshRowIds();
			this.stale = snapshot.stale;
			this.loading = false;
			this.error = null;
			this.#ready = true;

			for (const rowId of new Set([...previousIds, ...this.rowIds])) this.#emitRow(rowId);
			this.#emit();
		} else {
			const previousIds = [...target.rows.keys()];

			if (target.kind === 'work') {
				for (const id of previousIds) this.#workRows.delete(id);

				for (const row of snapshot.rows) this.#workRows.set(row.id, row);
				this.#workIds.set(
					target.rowId,
					snapshot.rows.map((row) => row.id)
				);
				this.#emitWork(target.rowId);
			}

			target.rows = new Map(snapshot.rows.map((row) => [row.id, row]));

			for (const id of new Set([...previousIds, ...target.rows.keys()])) this.#emitRow(id);
		}

		this.#resumeInterests();
	}

	#applyBatch(target: Target, event: Extract<TranscriptEvent, { type: 'batch' }>) {
		const rows = target === 'thread' ? this.#window : target.rows;
		let added = false;

		for (const update of event.updates) {
			if (update.type === 'append') {
				this.#append(target, update);
				continue;
			}

			added ||= !rows.has(update.row.id);
			this.#cancelRepair(target, update.row.id);
			this.#setRow(target, update.row);
		}

		if (added && target === 'thread') {
			this.#refreshRowIds();
			this.#emit();
		} else if (added && target !== 'thread' && target.kind === 'work') {
			this.#workIds.set(target.rowId, [...rows.keys()]);
			this.#emitWork(target.rowId);
		}

		this.#resumeInterests();
	}

	#refreshRowIds() {
		this.rowIds = [...this.#window.keys()];
	}

	#setRow(target: Target, row: TranscriptRow) {
		const rows = target === 'thread' ? this.#window : target.rows;
		rows.set(row.id, row);

		if (target !== 'thread' && target.kind === 'work') this.#workRows.set(row.id, row);
		this.#emitRow(row.id);
	}

	#append(target: Target, append: Append) {
		const rows = target === 'thread' ? this.#window : target.rows;
		const repair = this.#repairs.get(target)?.get(append.rowId);

		if (repair) {
			repair.appends.push(append);

			return;
		}

		const row = rows.get(append.rowId);

		if (
			row &&
			(row.kind === 'text' || row.kind === 'reasoning') &&
			row.text !== undefined &&
			row.text.length === append.offset
		) {
			this.#setRow(target, { ...row, text: row.text + append.text });

			return;
		}

		const connection = this.#connection;

		if (!connection) return;
		const pending: Repair = { abort: new AbortController(), appends: [append] };
		const repairs = this.#repairs.get(target) ?? new Map<string, Repair>();
		repairs.set(append.rowId, pending);
		this.#repairs.set(target, repairs);
		void this.#repair(connection, target, append.rowId, pending);
	}

	async #repair(connection: Connection, target: Target, rowId: string, repair: Repair) {
		let retryMs = 1_000;

		while (!repair.abort.signal.aborted && this.#current(connection)) {
			try {
				const { row } = await connection.api.fetchTranscriptRow(
					{ ...connection.scope, rowId },
					repair.abort.signal
				);

				if (repair.abort.signal.aborted || !this.#current(connection)) return;

				if ((row.kind !== 'text' && row.kind !== 'reasoning') || row.text === undefined) {
					this.#cancelRepair(target, rowId);

					return;
				}

				let text = row.text;
				let gap = false;

				for (const append of repair.appends) {
					if (append.offset > text.length) {
						gap = true;
						break;
					}

					text += append.text.slice(text.length - append.offset);
				}

				if (!gap) {
					this.#applyBatch(target, {
						type: 'batch',
						updates: [{ type: 'row', row: { ...row, text } }]
					});

					return;
				}
			} catch {}

			await delay(repair.abort.signal, retryMs);
			retryMs = Math.min(retryMs * 2, 10_000);
		}
	}

	#cancelRepair(target: Target, rowId: string) {
		const repairs = this.#repairs.get(target);
		repairs?.get(rowId)?.abort.abort();
		repairs?.delete(rowId);

		if (repairs?.size === 0) this.#repairs.delete(target);
	}

	#cancelRepairs(target: Target) {
		for (const repair of this.#repairs.get(target)?.values() ?? []) repair.abort.abort();
		this.#repairs.delete(target);
	}

	#reset(target: Target) {
		if (target !== 'thread') {
			this.#replace(target, { type: 'snapshot', rows: [], nextBefore: null, stale: false });

			return;
		}

		this.#ready = false;
		this.#generation += 1;
		this.#window.clear();
		this.#cancelRepairs('thread');
		this.#workRows.clear();
		this.#workIds.clear();
		this.rowIds = NO_ROWS;
		this.nextBefore = null;
		this.loading = this.threadId !== null;
		this.loadingOlder = false;
		this.stale = this.#connection !== null;
		this.error = null;

		for (const interest of this.#interests.values()) {
			this.#cancelRepairs(interest);
			interest.abort?.abort();
			interest.abort = null;
			interest.rows.clear();
		}

		for (const rowId of this.#rowListeners.keys()) this.#emitRow(rowId);

		for (const rowId of this.#workListeners.keys()) this.#emitWork(rowId);
		this.#emit();
	}

	#open(kind: Interest['kind'], rowId: string) {
		const key = `${kind}:${rowId}`;
		let interest = this.#interests.get(key);

		if (!interest) {
			interest = { kind, rowId, users: 0, rows: new Map(), abort: null };
			this.#interests.set(key, interest);
		}

		interest.users += 1;
		this.#resumeInterests();
		let closed = false;

		return () => {
			if (closed) return;
			closed = true;
			interest.users -= 1;

			if (interest.users > 0) return;
			interest.abort?.abort();
			this.#interests.delete(key);
			this.#reset(interest);
		};
	}

	#resumeInterests() {
		const connection = this.#connection;

		if (!connection || !this.#ready) return;

		for (const interest of this.#interests.values()) {
			if (interest.abort || !this.getRow(interest.rowId)) continue;
			const abort = new AbortController();
			interest.abort = abort;
			void this.#watchTarget(connection, interest, abort);
		}
	}

	#stop() {
		this.#threadAbort?.abort();
		this.#threadAbort = null;
		this.#connection?.abort.abort();
		this.#connection = null;
		this.#reset('thread');
	}

	#emit() {
		this.#version += 1;

		for (const listener of this.#listeners) listener();
	}

	#emitRow(rowId: string) {
		for (const listener of this.#rowListeners.get(rowId) ?? []) listener();
	}

	#emitWork(rowId: string) {
		for (const listener of this.#workListeners.get(rowId) ?? []) listener();
	}
}

export function useTranscriptStore() {
	const [store] = useState(() => new TranscriptStore());
	useStore(store);

	return store;
}

export function useTranscriptRows(store: TranscriptStore) {
	return useSyncExternalStore(store.subscribe, store.getRowIds);
}

export function useTranscriptRow(store: TranscriptStore, rowId: string, detail = false) {
	return useSyncExternalStore(
		useCallback((listener) => store.subscribeRow(rowId, listener), [store, rowId]),
		useCallback(() => store.getRow(rowId, detail), [store, rowId, detail])
	);
}

export function useTranscriptExpanded(store: TranscriptStore, rowId: string, defaultValue = false) {
	const expanded = useSyncExternalStore(
		useCallback((listener) => store.subscribeRow(rowId, listener), [store, rowId]),
		useCallback(() => store.isExpanded(rowId, defaultValue), [store, rowId, defaultValue])
	);

	return [expanded, (value: boolean) => store.setExpanded(rowId, value)] as const;
}

export function useTranscriptWork(store: TranscriptStore, rowId: string) {
	return useSyncExternalStore(
		useCallback((listener) => store.subscribeWork(rowId, listener), [store, rowId]),
		useCallback(() => store.getWorkIds(rowId), [store, rowId])
	);
}

function listen(listeners: Map<string, Set<() => void>>, rowId: string, listener: () => void) {
	let subscriptions = listeners.get(rowId);

	if (!subscriptions) {
		subscriptions = new Set();
		listeners.set(rowId, subscriptions);
	}

	subscriptions.add(listener);

	return () => {
		subscriptions.delete(listener);

		if (subscriptions.size === 0) listeners.delete(rowId);
	};
}

function delay(signal: AbortSignal, ms: number) {
	if (signal.aborted) return Promise.resolve();

	return new Promise<void>((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener('abort', done);
			resolve();
		};

		const timer = setTimeout(done, ms);
		signal.addEventListener('abort', done, { once: true });
	});
}
