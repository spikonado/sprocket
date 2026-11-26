import { expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { TranscriptStore, useTranscriptExpanded } from '$lib/home/transcript-store';
import WorkDisclosure from './work-disclosure';
import WorkSectionDetails from './work-section-details';

it('folds auto-opened work once it settles and keeps explicit choices', () => {
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
	view.rerender(<Work running />);
	view.rerender(<Work running={false} />);
	expect(view.getByText('Work details')).toBeTruthy();
	fireEvent.click(view.getByRole('button', { name: 'Read 2 files' }));
	view.rerender(<Work running />);
	expect(view.queryByText('Work details')).toBeNull();
});
