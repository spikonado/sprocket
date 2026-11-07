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

/** Trap focus inside a modal container and restore it when disposed. */
export const trapFocus: Attachment<HTMLElement> = (container) => {
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
};

/**
 * Hide page chrome from assistive tech / interaction while a modal is open.
 * The attached node is the subtree that must stay available (dialog or mobile nav header).
 */
export const inertBackground: Attachment<HTMLElement> = (keep) => {
	const targets = [
		document.querySelector('header'),
		document.getElementById('main'),
		document.querySelector('footer')
	].filter((element): element is HTMLElement => {
		if (!(element instanceof HTMLElement)) {
			return false;
		}
		if (!keep) {
			return true;
		}
		return element !== keep && !element.contains(keep) && !keep.contains(element);
	});

	for (const element of targets) {
		element.inert = true;
	}

	return () => {
		for (const element of targets) {
			element.inert = false;
		}
	};
};

/** Render a node as a direct child of document.body. */
export function portal(node: HTMLElement) {
	document.body.appendChild(node);
	return {
		destroy() {
			node.remove();
		}
	};
}

/** Lock document scrolling while a modal or overlay is open. */
export const lockBodyScroll: Attachment = () => {
	const previousOverflow = document.body.style.overflow;
	document.body.style.overflow = 'hidden';
	return () => {
		document.body.style.overflow = previousOverflow;
	};
};

/** Close on Escape. Pass the closer; the returned function is the attachment. */
export function closeOnEscape(onClose: () => void): Attachment {
	return () => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				onClose();
			}
		};
		window.addEventListener('keydown', onKeyDown);
		return () => {
			window.removeEventListener('keydown', onKeyDown);
		};
	};
}

/**
 * Overlay open/close as one attachment so cleanup order is not left to
 * sibling `{@attach}` teardown. Unlock scroll and drop `inert` before
 * restoring focus; otherwise the opener (often inside `main`) cannot take it.
 */
export function lockOverlay(onClose: () => void): Attachment<HTMLElement> {
	return (node) => {
		const unlockScroll = lockBodyScroll(node);
		const releaseBackground = inertBackground(node);
		const releaseFocus = trapFocus(node);
		const stopEscape = closeOnEscape(onClose)(node);

		return () => {
			stopEscape?.();
			unlockScroll?.();
			releaseBackground?.();
			releaseFocus?.();
		};
	};
}
