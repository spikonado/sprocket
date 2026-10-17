import { expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import WorkDisclosure from './work-disclosure';

function disclosure(inProgress: boolean, details = 'Work details') {
	return (
		<WorkDisclosure inProgress={inProgress} summary="Read 2 files">
			{details}
		</WorkDisclosure>
	);
}

it.each([
	{ inProgress: true, expanded: 'true' },
	{ inProgress: false, expanded: 'false' }
])('defaults inProgress=$inProgress to expanded=$expanded', ({ inProgress, expanded }) => {
	const view = render(disclosure(inProgress));

	expect(view.getByRole('button', { name: 'Read 2 files' }).getAttribute('aria-expanded')).toBe(
		expanded
	);
	expect(view.queryByText('Work details') !== null).toBe(inProgress);
});

it('closes when work finishes and allows reopening the completed work', () => {
	const view = render(disclosure(true));
	const button = view.getByRole('button', { name: 'Read 2 files' });

	view.rerender(disclosure(false));

	expect(view.getByRole('button', { name: 'Read 2 files' })).toBe(button);
	expect(button.getAttribute('aria-expanded')).toBe('false');
	expect(view.queryByText('Work details')).toBeNull();
	fireEvent.click(button);
	expect(button.getAttribute('aria-expanded')).toBe('true');
	expect(view.getByText('Work details')).toBeTruthy();
});

it.each([true, false])(
	'preserves manual toggles while content updates with inProgress=%s',
	(inProgress) => {
		const view = render(disclosure(inProgress));
		const button = view.getByRole('button', { name: 'Read 2 files' });

		fireEvent.click(button);
		view.rerender(disclosure(inProgress, 'Updated work details'));

		expect(button.getAttribute('aria-expanded')).toBe(String(!inProgress));
		expect(view.queryByText('Updated work details') !== null).toBe(!inProgress);
		fireEvent.click(button);
		expect(button.getAttribute('aria-expanded')).toBe(String(inProgress));
		expect(view.queryByText('Updated work details') !== null).toBe(inProgress);
	}
);

it('resets manual choices on each status change', () => {
	const view = render(disclosure(true));
	const button = view.getByRole('button', { name: 'Read 2 files' });

	fireEvent.click(button);
	expect(button.getAttribute('aria-expanded')).toBe('false');
	view.rerender(disclosure(false));
	fireEvent.click(button);
	expect(button.getAttribute('aria-expanded')).toBe('true');
	view.rerender(disclosure(true));
	expect(button.getAttribute('aria-expanded')).toBe('true');
	expect(view.getByText('Work details')).toBeTruthy();
	view.rerender(disclosure(false));
	expect(button.getAttribute('aria-expanded')).toBe('false');
	expect(view.queryByText('Work details')).toBeNull();
});
