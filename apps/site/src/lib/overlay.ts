import type { Attachment } from 'svelte/attachments';

const FOCUSABLE_SELECTOR = [
	'a[href]',
	'button:not([disabled])',
	'textarea:not([disabled])',
	'input:not([disabled])',
	'select:not([disabled])',
	'[tabindex]:not([tabindex="-1"])'
].join(',');

function getFocusable(container: HTMLElement): HTMLElement[] {
	return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter((element) => {
		if (element.closest('[disabled], [hidden], [aria-hidden="true"]')) {
			return false;
		}

		return element.getClientRects().length > 0 || element === document.activeElement;
	});
}

function trapFocus(container: HTMLElement): () => void {
	const previouslyFocused =
		document.activeElement instanceof HTMLElement ? document.activeElement : null;

	if (!container.hasAttribute('tabindex')) {
		container.tabIndex = -1;
	}

	const focusable = getFocusable(container);
	(focusable[0] ?? container).focus({ preventScroll: true });

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key !== 'Tab') {
			return;
		}

		const items = getFocusable(container);

		if (items.length === 0) {
			event.preventDefault();
			container.focus({ preventScroll: true });

			return;
		}

		const first = items[0];
		const last = items[items.length - 1];
		const active = document.activeElement;

		if (!(active instanceof Node) || !container.contains(active)) {
			event.preventDefault();
			(event.shiftKey ? last : first).focus();

			return;
		}

		if (event.shiftKey) {
			if (active === first || active === container) {
				event.preventDefault();
				last.focus();
			}

			return;
		}

		if (active === last) {
			event.preventDefault();
			first.focus();
		}
	};

	// Capture so Tab cannot move into page content behind the dialog.
	document.addEventListener('keydown', onKeyDown, true);

	return () => {
		document.removeEventListener('keydown', onKeyDown, true);
		previouslyFocused?.focus({ preventScroll: true });
	};
}

/** Makes the page chrome around `keep` inert, leaving `keep` and anything containing it usable. */
function inertBackground(keep: HTMLElement): () => void {
	const targets = [
		document.querySelector('header'),
		document.getElementById('main'),
		document.querySelector('footer')
	].filter(
		(element): element is HTMLElement =>
			element instanceof HTMLElement &&
			element !== keep &&
			!element.contains(keep) &&
			!keep.contains(element)
	);

	for (const element of targets) {
		element.inert = true;
	}

	return () => {
		for (const element of targets) {
			element.inert = false;
		}
	};
}

function lockBodyScroll(): () => void {
	const previousOverflow = document.body.style.overflow;
	document.body.style.overflow = 'hidden';

	return () => {
		document.body.style.overflow = previousOverflow;
	};
}

function closeOnEscape(onClose: () => void): () => void {
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === 'Escape') {
			onClose();
		}
	};

	window.addEventListener('keydown', onKeyDown);

	return () => window.removeEventListener('keydown', onKeyDown);
}

/** Render a node as a direct child of document.body. */
export function portal(node: HTMLElement) {
	document.body.appendChild(node);

	return {
		destroy() {
			node.remove();
		}
	};
}

/**
 * Unlock scroll and drop `inert` before restoring focus; otherwise the opener (often inside
 * `main`) cannot take it.
 */
export function lockOverlay(onClose: () => void): Attachment<HTMLElement> {
	return (node) => {
		const unlockScroll = lockBodyScroll();
		const releaseBackground = inertBackground(node);
		const releaseFocus = trapFocus(node);
		const stopEscape = closeOnEscape(onClose);

		return () => {
			stopEscape();
			unlockScroll();
			releaseBackground();
			releaseFocus();
		};
	};
}
