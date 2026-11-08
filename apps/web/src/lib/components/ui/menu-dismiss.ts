import { pushEscapeLayer } from '$lib/use-escape-layer';

export function listenOpenMenuDismiss(options: {
	getRoot: () => HTMLElement | null | readonly (HTMLElement | null)[];
	onOutside: () => void;
	onEscape: () => void;
}): () => void {
	function handlePointerDown(event: PointerEvent) {
		const target = event.target;

		if (!(target instanceof Node)) {
			return;
		}

		const roots = [options.getRoot()].flat();

		if (!roots.some((root) => root?.contains(target))) {
			options.onOutside();
		}
	}

	document.addEventListener('pointerdown', handlePointerDown);
	const removeEscapeLayer = pushEscapeLayer({ current: options.onEscape });

	return () => {
		document.removeEventListener('pointerdown', handlePointerDown);
		removeEscapeLayer();
	};
}
