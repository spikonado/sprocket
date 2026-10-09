import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import SettingsSidebar from './settings-sidebar';

it('keeps settings navigation and theme controls without an inbox close button', () => {
	const onBack = vi.fn();
	const onNavigate = vi.fn();
	const onThemeChange = vi.fn();
	render(
		<SettingsSidebar
			activePage="general"
			theme="dark"
			onBack={onBack}
			onNavigate={onNavigate}
			onThemeChange={onThemeChange}
		/>
	);

	expect(screen.queryByRole('button', { name: 'Close sidebar' })).toBeNull();
	expect(
		within(screen.getByRole('navigation', { name: 'Settings' }))
			.getAllByRole('button')
			.map((button) => button.textContent)
	).toEqual(['General', 'Account', 'Usage', 'BYOK/BYOS', 'Payments']);
	fireEvent.click(screen.getByRole('button', { name: 'Switch to light mode' }));
	expect(onThemeChange).toHaveBeenCalledWith('light');
	fireEvent.click(screen.getByRole('button', { name: 'General', current: 'page' }));
	expect(onNavigate).toHaveBeenCalledWith('general');
	fireEvent.click(screen.getByRole('button', { name: 'Account' }));
	expect(onNavigate).toHaveBeenCalledWith('account');
	fireEvent.click(screen.getByRole('button', { name: 'Back' }));
	expect(onBack).toHaveBeenCalledOnce();
});
