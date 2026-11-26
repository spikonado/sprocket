import { expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { Activity } from 'react';
import { fixtureId } from '$lib/convex-test-client';
import type { MessageAttachment } from '$lib/types/sprocket';
import TranscriptAttachment from './transcript-attachment';

it('lets a download hidden mid-flight be retried once shown again', async () => {
	const attachment: MessageAttachment = {
		fileId: fixtureId<'files'>('file'),
		name: 'notes.txt',
		mediaType: 'text/plain',
		size: 1
	};

	const loadAttachment = vi.fn(() => new Promise<string | null>(() => {}));

	const view = (mode: 'visible' | 'hidden') => (
		<Activity mode={mode}>
			<TranscriptAttachment
				attachment={attachment}
				loadAttachment={loadAttachment}
				onOpen={vi.fn()}
			/>
		</Activity>
	);

	const { getByRole, rerender } = render(view('visible'));

	await act(async () => fireEvent.click(getByRole('button', { name: 'Download notes.txt' })));
	expect(getByRole('status', { name: 'Downloading notes.txt' })).toBeTruthy();
	rerender(view('hidden'));
	rerender(view('visible'));
	await act(async () => fireEvent.click(getByRole('button', { name: 'Download notes.txt' })));
	expect(loadAttachment).toHaveBeenCalledTimes(2);
});

it('shows a deleted file without loading it', () => {
	const loadAttachment = vi.fn();

	const { getByText } = render(
		<TranscriptAttachment
			attachment={{ name: 'robot.png', mediaType: 'image/png', size: 1 }}
			loadAttachment={loadAttachment}
			onOpen={vi.fn()}
		/>
	);

	expect(getByText('robot.png (deleted)')).toBeTruthy();
	expect(loadAttachment).not.toHaveBeenCalled();
});
