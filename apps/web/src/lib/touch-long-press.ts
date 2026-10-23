const HOLD_MS = 500;

const MOVE_TOLERANCE_PX = 10;

const RELEASE_EVENTS_WINDOW_MS = 400;

const RELEASE_EVENTS = ['mousedown', 'mouseup', 'click'] as const;

type Press = { pointerId: number; x: number; y: number; timer: number; opened: boolean };

/**
 * iOS Safari never fires `contextmenu` on long-press, so a touch hold dispatches one on the pressed
 * element and existing `onContextMenu` handlers open their menus. Android fires its own, which wins.
 */
export function installTouchLongPress(): () => void {
	let press: Press | null = null;
	let swallowTimer: number | null = null;

	function cancel() {
		if (press) clearTimeout(press.timer);
		press = null;
	}

	function swallow(event: Event) {
		event.preventDefault();
		event.stopPropagation();
	}

	function stopSwallowing() {
		if (swallowTimer === null) return;
		clearTimeout(swallowTimer);
		swallowTimer = null;

		for (const type of RELEASE_EVENTS) window.removeEventListener(type, swallow, true);
	}

	function swallowReleaseEvents() {
		stopSwallowing();

		for (const type of RELEASE_EVENTS) window.addEventListener(type, swallow, true);
		swallowTimer = window.setTimeout(stopSwallowing, RELEASE_EVENTS_WINDOW_MS);
	}

	function onPointerDown(event: PointerEvent) {
		cancel();
		stopSwallowing();

		if (event.pointerType !== 'touch' || !event.isPrimary) return;
		const element = event.composedPath()[0];

		if (
			!(element instanceof Element) ||
			element.closest('input, textarea, select, [contenteditable="true"]')
		)
			return;
		const { clientX, clientY } = event;

		const current: Press = {
			pointerId: event.pointerId,
			x: clientX,
			y: clientY,
			opened: false,
			timer: window.setTimeout(() => {
				const contextMenu = new MouseEvent('contextmenu', {
					bubbles: true,
					cancelable: true,
					composed: true,
					clientX,
					clientY
				});

				current.opened = !element.dispatchEvent(contextMenu);
			}, HOLD_MS)
		};

		press = current;
	}

	function onPointerMove(event: PointerEvent) {
		if (!press || event.pointerId !== press.pointerId) return;

		if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > MOVE_TOLERANCE_PX) cancel();
	}

	function onPointerEnd(event: PointerEvent) {
		if (!press || event.pointerId !== press.pointerId) return;

		// The menu opened under the finger, so the release would otherwise hit its backdrop and close it.
		if (press.opened) swallowReleaseEvents();
		cancel();
	}

	function onNativeContextMenu(event: MouseEvent) {
		if (!event.isTrusted || !press) return;

		if (press.opened) swallow(event);
		else clearTimeout(press.timer);
	}

	window.addEventListener('pointerdown', onPointerDown, true);
	window.addEventListener('pointermove', onPointerMove, true);
	window.addEventListener('pointerup', onPointerEnd, true);
	window.addEventListener('pointercancel', onPointerEnd, true);
	window.addEventListener('contextmenu', onNativeContextMenu, true);

	return () => {
		cancel();
		stopSwallowing();
		window.removeEventListener('pointerdown', onPointerDown, true);
		window.removeEventListener('pointermove', onPointerMove, true);
		window.removeEventListener('pointerup', onPointerEnd, true);
		window.removeEventListener('pointercancel', onPointerEnd, true);
		window.removeEventListener('contextmenu', onNativeContextMenu, true);
	};
}
