import { expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import WorkDisclosure from './work-disclosure';

it.each([
	{ inProgress: true, label: 'Working', expanded: 'true' },
	{ inProgress: false, label: 'Worked', expanded: 'false' }
])('defaults $label to expanded=$expanded', ({ inProgress, label, expanded }) => {
	const view = render(<WorkDisclosure inProgress={inProgress}>Work details</WorkDisclosure>);

	expect(view.getByRole('button', { name: label }).getAttribute('aria-expanded')).toBe(expanded);
	expect(view.queryByText('Work details') !== null).toBe(inProgress);
});

it('closes Working when it becomes Worked and allows reopening the completed work', () => {
	const view = render(<WorkDisclosure inProgress>Work details</WorkDisclosure>);
	const button = view.getByRole('button', { name: 'Working' });

	view.rerender(<WorkDisclosure inProgress={false}>Work details</WorkDisclosure>);

	expect(view.getByRole('button', { name: 'Worked' })).toBe(button);
	expect(button.getAttribute('aria-expanded')).toBe('false');
	expect(view.queryByText('Work details')).toBeNull();
	fireEvent.click(button);
	expect(button.getAttribute('aria-expanded')).toBe('true');
	expect(view.getByText('Work details')).toBeTruthy();
});

it.each([
	{ inProgress: true, label: 'Working' },
	{ inProgress: false, label: 'Worked' }
])('preserves manual toggles while $label updates', ({ inProgress, label }) => {
	const view = render(<WorkDisclosure inProgress={inProgress}>Work details</WorkDisclosure>);
	const button = view.getByRole('button', { name: label });

	fireEvent.click(button);
	view.rerender(<WorkDisclosure inProgress={inProgress}>Updated work details</WorkDisclosure>);

	expect(button.getAttribute('aria-expanded')).toBe(String(!inProgress));
	expect(view.queryByText('Updated work details') !== null).toBe(!inProgress);
	fireEvent.click(button);
	expect(button.getAttribute('aria-expanded')).toBe(String(inProgress));
	expect(view.queryByText('Updated work details') !== null).toBe(inProgress);
});

it('resets manual choices on each status change', () => {
	const view = render(<WorkDisclosure inProgress>Work details</WorkDisclosure>);
	const button = view.getByRole('button', { name: 'Working' });

	fireEvent.click(button);
	expect(button.getAttribute('aria-expanded')).toBe('false');
	view.rerender(<WorkDisclosure inProgress={false}>Work details</WorkDisclosure>);
	fireEvent.click(button);
	expect(button.getAttribute('aria-expanded')).toBe('true');
	view.rerender(<WorkDisclosure inProgress>Work details</WorkDisclosure>);
	expect(button.getAttribute('aria-expanded')).toBe('true');
	expect(view.getByText('Work details')).toBeTruthy();
	view.rerender(<WorkDisclosure inProgress={false}>Work details</WorkDisclosure>);
	expect(button.getAttribute('aria-expanded')).toBe('false');
	expect(view.queryByText('Work details')).toBeNull();
});
