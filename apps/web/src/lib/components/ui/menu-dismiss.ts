/** Close an open menu on outside pointerdown or Escape. */
export function listenOpenMenuDismiss(options: {
	getRoot: () => HTMLElement | null;
	onOutside: () => void;
	onEscape: () => void;
}): () => void {
	function handlePointerDown(event: PointerEvent) {
		const target = event.target;
		if (!(target instanceof Node)) {
			return;
		}

		if (!options.getRoot()?.contains(target)) {
			options.onOutside();
		}
	}

	function handleKeyDown(event: KeyboardEvent) {
		if (event.key !== 'Escape') {
			return;
		}

		options.onEscape();
	}

	document.addEventListener('pointerdown', handlePointerDown);
	document.addEventListener('keydown', handleKeyDown);

	return () => {
		document.removeEventListener('pointerdown', handlePointerDown);
		document.removeEventListener('keydown', handleKeyDown);
	};
}
