import { useCallback, useEffect, type RefObject } from 'react';
import { useLatest } from '$lib/use-latest';

type EscapeLayer = Readonly<RefObject<() => void>>;

const layers: EscapeLayer[] = [];

function handleEscape(event: KeyboardEvent) {
	if (event.key !== 'Escape' || event.defaultPrevented) return;
	event.preventDefault();
	layers.at(-1)?.current();
}

/** Until the returned function runs, Escape calls `layer` only if no layer pushed after it is still open. */
export function pushEscapeLayer(layer: EscapeLayer): () => void {
	if (layers.length === 0) window.addEventListener('keydown', handleEscape);
	layers.push(layer);

	return () => {
		layers.splice(layers.indexOf(layer), 1);

		if (layers.length === 0) window.removeEventListener('keydown', handleEscape);
	};
}

export function useEscapeLayer(onEscape: () => void, active = true) {
	const layer = useLatest(onEscape);

	useEffect(() => (active ? pushEscapeLayer(layer) : undefined), [active, layer]);

	return useCallback(() => layers.at(-1) === layer, [layer]);
}
