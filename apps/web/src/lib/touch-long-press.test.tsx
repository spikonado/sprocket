import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installTouchLongPress } from './touch-long-press';

let uninstall: () => void;

beforeEach(() => {
	vi.useFakeTimers();
	uninstall = installTouchLongPress();
});

afterEach(() => {
	uninstall();
	vi.useRealTimers();
});

function touch(type: string, target: Element) {
	fireEvent(
		target,
		new PointerEvent(type, { bubbles: true, pointerId: 1, pointerType: 'touch', isPrimary: true })
	);
}

it('opens the context menu on a touch hold, drops the release click, and takes the next tap', () => {
	const onContextMenu = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
	const onClick = vi.fn();
	render(
		<button type="button" onContextMenu={onContextMenu} onClick={onClick}>
			Row
		</button>
	);
	const row = screen.getByText('Row');

	touch('pointerdown', row);
	vi.advanceTimersByTime(500);
	touch('pointerup', row);
	fireEvent.click(row);

	expect(onContextMenu).toHaveBeenCalledOnce();
	expect(onClick).not.toHaveBeenCalled();

	touch('pointerdown', row);
	touch('pointerup', row);
	fireEvent.click(row);
	expect(onClick).toHaveBeenCalledOnce();
});
