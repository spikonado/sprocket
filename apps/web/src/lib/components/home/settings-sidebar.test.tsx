import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import SettingsSidebar from './settings-sidebar';

it('keeps settings navigation and theme controls without an inbox close button', () => {
	const onBack = vi.fn();
	const onNavigate = vi.fn();
	const onThemeChange = vi.fn();
	render(
		<SettingsSidebar
			activePage="account"
			theme="dark"
			onBack={onBack}
			onNavigate={onNavigate}
			onThemeChange={onThemeChange}
		/>
	);

	expect(screen.queryByRole('button', { name: 'Close sidebar' })).toBeNull();
	fireEvent.click(screen.getByRole('button', { name: 'Switch to light mode' }));
	expect(onThemeChange).toHaveBeenCalledWith('light');
	fireEvent.click(screen.getByRole('button', { name: 'Account', current: 'page' }));
	expect(onNavigate).toHaveBeenCalledWith('account');
	fireEvent.click(screen.getByRole('button', { name: 'Back' }));
	expect(onBack).toHaveBeenCalledOnce();
});
