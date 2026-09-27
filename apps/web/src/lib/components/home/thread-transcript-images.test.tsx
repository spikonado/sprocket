import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { Id } from '$convex/_generated/dataModel';
import type { TranscriptDisplayRow } from '$lib/types/sprocket';
import ThreadTranscript from './thread-transcript';

it('opens a transcript attachment in the image viewer and restores focus after Escape', async () => {
	const imageUrl = 'https://example.com/board.png';
	const loadAttachment = vi.fn(async () => imageUrl);
	const message = {
		id: 'prompt:1',
		// SAFETY: Fixture IDs never leave the mounted component.
		threadId: 'thread' as Id<'threadRecords'>,
		// SAFETY: Fixture IDs never leave the mounted component.
		runId: 'run' as Id<'runs'>,
		kind: 'prompt',
		text: 'Check this board',
		attachments: [
			{
				// SAFETY: The test loader resolves this fixture ID without a backend.
				storageId: 'image' as Id<'_storage'>,
				name: 'board.png',
				mediaType: 'image/png',
				size: 100
			}
		],
		sequence: 1,
		itemCount: 0,
		pendingTools: 0,
		closed: true,
		revision: 1
	} satisfies TranscriptDisplayRow;
	render(
		<ThreadTranscript
			currentError={null}
			runError={null}
			messages={[message]}
			actions={[]}
			activeRunId={null}
			project={null}
			loadAttachment={loadAttachment}
		/>
	);
	const trigger = await screen.findByRole('button', { name: 'View board.png' });
	expect(loadAttachment).toHaveBeenCalledWith(message.attachments[0].storageId);
	trigger.focus();
	fireEvent.click(trigger);
	const dialog = screen.getByRole('dialog', { name: 'Image preview: board.png' });
	expect(dialog.querySelector('img')?.src).toBe(imageUrl);
	await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
	fireEvent.keyDown(document, { key: 'Escape' });
	expect(screen.queryByRole('dialog')).toBeNull();
	expect(document.activeElement).toBe(trigger);
});
