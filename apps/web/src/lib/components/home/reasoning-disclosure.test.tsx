import { expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import ReasoningDisclosure from './reasoning-disclosure';

it('starts closed and streams reasoning text once opened', () => {
	const view = render(<ReasoningDisclosure text="Inspect" inProgress />);
	const toggle = view.getByRole('button', { name: 'Reasoning' });

	expect(toggle.getAttribute('aria-expanded')).toBe('false');
	fireEvent.click(toggle);
	view.rerender(<ReasoningDisclosure text="Inspect the workspace." inProgress />);
	expect(view.getByText('Inspect the workspace.')).toBeTruthy();
	view.rerender(<ReasoningDisclosure text="Inspect the workspace." inProgress={false} />);
	expect(view.getByRole('button', { name: 'Reasoned' }).getAttribute('aria-expanded')).toBe('true');
	fireEvent.click(toggle);
	expect(toggle.getAttribute('aria-expanded')).toBe('false');
});
