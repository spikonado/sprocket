import { expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { TranscriptStore, useTranscriptExpanded } from '$lib/home/transcript-store';
import WorkDisclosure from './work-disclosure';
import WorkSectionDetails from './work-section-details';

it('calls onToggle and renders details according to the controlled expanded prop', () => {
	const onToggle = vi.fn();

	const disclosure = (expanded: boolean) => (
		<WorkDisclosure
			inProgress={false}
			summary="Read 2 files"
			expanded={expanded}
			onToggle={onToggle}
		>
			Work details
		</WorkDisclosure>
	);

	const view = render(disclosure(false));
	const button = view.getByRole('button', { name: 'Read 2 files' });
	fireEvent.click(button);
	expect(onToggle).toHaveBeenCalledTimes(1);
	expect(button.getAttribute('aria-expanded')).toBe('false');
	expect(view.queryByText('Work details')).toBeNull();

	view.rerender(disclosure(true));
	expect(button.getAttribute('aria-expanded')).toBe('true');
	expect(view.getByText('Work details')).toBeTruthy();
	view.rerender(disclosure(false));
	expect(button.getAttribute('aria-expanded')).toBe('false');
	expect(view.queryByText('Work details')).toBeNull();
});

it('folds auto-opened work once it settles', () => {
	const store = new TranscriptStore();
	const rowId = 'work:1';

	function Work({ running }: { running: boolean }) {
		const [expanded, setExpanded] = useTranscriptExpanded(store, rowId, running);

		return (
			<WorkDisclosure
				inProgress={running}
				summary="Read 2 files"
				expanded={expanded}
				onToggle={() => setExpanded(!expanded)}
			>
				<WorkSectionDetails store={store} rowId={rowId} />
				Work details
			</WorkDisclosure>
		);
	}

	const view = render(<Work running />);
	expect(view.getByText('Work details')).toBeTruthy();
	view.rerender(<Work running={false} />);
	expect(view.queryByText('Work details')).toBeNull();
	fireEvent.click(view.getByRole('button', { name: 'Read 2 files' }));
	expect(view.getByText('Work details')).toBeTruthy();
});
