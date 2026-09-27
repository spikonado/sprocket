import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import ErrorBoundary from './error-boundary';

it('offers recovery when a descendant fails to render', () => {
	const onCaughtError = vi.fn();
	function BrokenScreen(): never {
		throw new Error('Failed to render');
	}

	render(
		<ErrorBoundary>
			<BrokenScreen />
		</ErrorBoundary>,
		{ onCaughtError }
	);
	expect(screen.getByRole('heading').textContent).toBe('Unable to display Sprocket');
	expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
	expect(onCaughtError).toHaveBeenCalled();
});
