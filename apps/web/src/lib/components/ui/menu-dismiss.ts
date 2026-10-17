/** Close an open menu on pointerdown outside its root(s) or Escape. */
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
