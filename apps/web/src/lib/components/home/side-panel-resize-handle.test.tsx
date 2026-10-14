import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import SidePanelResizeHandle from './side-panel-resize-handle';

function Panel() {
	const [width, setWidth] = useState(400);

	return (
		<SidePanelResizeHandle width={width} minWidth={320} maxWidth={800} onWidthChange={setWidth} />
	);
}

afterEach(() => vi.unstubAllGlobals());

it('resizes from the keyboard, respects limits, and resets on double-click', () => {
	render(<Panel />);
	const handle = screen.getByRole('separator', { name: 'Resize side panel' });
	fireEvent.keyDown(handle, { key: 'ArrowLeft' });
	expect(handle.getAttribute('aria-valuenow')).toBe('416');
	fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
	expect(handle.getAttribute('aria-valuenow')).toBe('352');
	fireEvent.keyDown(handle, { key: 'Home' });
	fireEvent.keyDown(handle, { key: 'ArrowRight' });
	expect(handle.getAttribute('aria-valuenow')).toBe('320');
	fireEvent.keyDown(handle, { key: 'End' });
	fireEvent.keyDown(handle, { key: 'ArrowLeft' });
	expect(handle.getAttribute('aria-valuenow')).toBe('800');
	fireEvent(handle, new MouseEvent('dblclick', { bubbles: true }));
	expect(handle.getAttribute('aria-valuenow')).toBe('320');
});

it('captures the pointer and grows leftward until the drag ends', () => {
	class TestPointerEvent extends MouseEvent {
		pointerId: number;

		constructor(type: string, init: PointerEventInit) {
			super(type, init);
			this.pointerId = init.pointerId ?? 0;
		}
	}

	vi.stubGlobal('PointerEvent', TestPointerEvent);
	render(<Panel />);
	const handle = screen.getByRole('separator');
	handle.setPointerCapture = vi.fn();
	handle.hasPointerCapture = vi.fn(() => true);
	handle.releasePointerCapture = vi.fn();
	fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 1000 });
	expect(handle.setPointerCapture).toHaveBeenCalledWith(1);
	expect(document.activeElement).toBe(handle);
	fireEvent.pointerMove(handle, { pointerId: 1, clientX: 800 });
	expect(handle.getAttribute('aria-valuenow')).toBe('600');
	fireEvent.pointerMove(handle, { pointerId: 1, clientX: 0 });
	expect(handle.getAttribute('aria-valuenow')).toBe('800');
	fireEvent.pointerUp(handle, { pointerId: 1 });
	expect(handle.releasePointerCapture).toHaveBeenCalledWith(1);

	fireEvent.pointerDown(handle, { pointerId: 2, button: 0, clientX: 1000 });
	fireEvent.pointerMove(handle, { pointerId: 2, clientX: 1480 });
	expect(handle.getAttribute('aria-valuenow')).toBe('320');
	fireEvent.pointerCancel(handle, { pointerId: 2 });
	expect(handle.releasePointerCapture).toHaveBeenCalledWith(2);
});
