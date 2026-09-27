import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import AuthGate from './auth-gate';

it('keeps account recovery available while waiting for Convex confirmation', () => {
	const onRetry = vi.fn();
	const onSignOut = vi.fn();
	const props = {
		authState: {
			isLoading: true,
			isConfigured: true,
			isAuthenticated: true,
			connectionFailed: false,
			error: null
		},
		onSignIn: vi.fn(),
		onSignUp: vi.fn(),
		onSignOut,
		onRetry
	};
	const { rerender } = render(<AuthGate {...props} />);
	expect(screen.getByRole('heading').textContent).toBe('Confirming your session');
	expect(screen.getByRole('button', { name: 'Sign Out' })).toBeTruthy();
	rerender(
		<AuthGate
			{...props}
			authState={{
				...props.authState,
				isLoading: false,
				connectionFailed: true,
				error: 'Connection unavailable'
			}}
		/>
	);
	expect(screen.getByRole('alert').textContent).toBe('Connection unavailable');
	fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
	expect(onRetry).toHaveBeenCalledOnce();
	fireEvent.click(screen.getByRole('button', { name: 'Sign Out' }));
	expect(onSignOut).toHaveBeenCalledOnce();
});

it('disables background interaction while the browser sign-in dialog is open', () => {
	const { container } = render(
		<AuthGate
			authState={{
				isLoading: false,
				isConfigured: true,
				isAuthenticated: false,
				connectionFailed: false,
				error: 'Open the browser'
			}}
			overlayOpen
			onSignIn={() => {}}
			onSignUp={() => {}}
			onRetry={() => {}}
			onSignOut={() => {}}
		/>
	);
	expect(container.firstElementChild?.hasAttribute('inert')).toBe(true);
	expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
	expect(screen.queryByRole('alert')).toBeNull();
});
