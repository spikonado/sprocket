import { expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import ReasoningDisclosure from './reasoning-disclosure';

it('opens active reasoning, allows manual toggling, and collapses when reasoning finishes', () => {
	const view = render(<ReasoningDisclosure text="Inspect the workspace." inProgress />);
	const active = view.getByRole('button', { name: 'Reasoning' });

	expect(active.getAttribute('aria-expanded')).toBe('true');
	expect(view.getByText('Inspect the workspace.')).toBeTruthy();
	fireEvent.click(active);
	expect(active.getAttribute('aria-expanded')).toBe('false');
	fireEvent.click(active);
	view.rerender(<ReasoningDisclosure text="Inspect the workspace." inProgress={false} />);
	const completed = view.getByRole('button', { name: 'Reasoned' });

	expect(completed.getAttribute('aria-expanded')).toBe('false');
	fireEvent.click(completed);
	expect(completed.getAttribute('aria-expanded')).toBe('true');
	expect(view.getByText('Inspect the workspace.')).toBeTruthy();
});
