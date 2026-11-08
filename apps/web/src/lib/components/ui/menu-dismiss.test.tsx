import { fireEvent } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { listenOpenMenuDismiss } from './menu-dismiss';

it('leaves Escape inside an open dialog to the dialog', () => {
	const closeMenu = vi.fn();

	const stopMenu = listenOpenMenuDismiss({
		getRoot: () => null,
		onOutside: vi.fn(),
		onEscape: closeMenu
	});

	const dialog = document.body.appendChild(document.createElement('dialog'));
	dialog.open = true;
	const button = dialog.appendChild(document.createElement('button'));

	expect(fireEvent.keyDown(button, { key: 'Escape' })).toBe(true);
	dialog.remove();
	fireEvent.keyDown(document, { key: 'Escape' });
	expect(closeMenu).toHaveBeenCalledOnce();
	stopMenu();
});
