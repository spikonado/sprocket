import { useSyncExternalStore } from 'react';

export type Store<T> = {
	getSnapshot: () => T;
	subscribe: (listener: () => void) => () => void;
};

export function createStore<T>(initialValue: T) {
	let value = initialValue;
	const listeners = new Set<() => void>();

	const set = (next: T) => {
		if (Object.is(value, next)) return;
		value = next;

		for (const listener of listeners) listener();
	};

	return {
		getSnapshot: () => value,
		subscribe(listener: () => void) {
			listeners.add(listener);

			return () => {
				listeners.delete(listener);
			};
		},
		set,
		update: (updater: (current: T) => T) => set(updater(value))
	};
}

export function selectStore<T, U>(store: Store<T>, select: (value: T) => U): Store<U> {
	let source = store.getSnapshot();
	let selected = select(source);

	return {
		subscribe: store.subscribe,
		getSnapshot() {
			const next = store.getSnapshot();

			if (!Object.is(source, next)) {
				source = next;
				selected = select(next);
			}

			return selected;
		}
	};
}

export function useStore<T>(store: Store<T>): T {
	return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
