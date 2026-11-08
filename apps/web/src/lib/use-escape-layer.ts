import { useCallback, useEffect, type RefObject } from 'react';
import { useLatest } from '$lib/use-latest';

const layers: RefObject<() => void>[] = [];

function handleEscape(event: KeyboardEvent) {
	if (event.key !== 'Escape' || event.defaultPrevented) return;
	event.preventDefault();
	layers.at(-1)?.current();
}

/** While `active`, Escape calls `onEscape` only if no layer opened after this one is still open. */
export function useEscapeLayer(onEscape: () => void, active = true) {
	const layer = useLatest(onEscape);

	useEffect(() => {
		if (!active) return;

		if (layers.length === 0) window.addEventListener('keydown', handleEscape);
		layers.push(layer);

		return () => {
			layers.splice(layers.indexOf(layer), 1);

			if (layers.length === 0) window.removeEventListener('keydown', handleEscape);
		};
	}, [active, layer]);

	return useCallback(() => layers.at(-1) === layer, [layer]);
}
