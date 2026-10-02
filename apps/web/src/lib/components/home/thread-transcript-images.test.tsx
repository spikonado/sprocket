import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { Id } from '@convex/_generated/dataModel';
import type { TranscriptDisplayRow, TranscriptMessage } from '$lib/types/sprocket';
import ThreadTranscript from './thread-transcript';

it.each(['persisted', 'live-fallback', 'live-section'])(
	'resolves %s model images within their message thread with or without a project',
	(kind) => {
		// SAFETY: Fixture IDs never leave the mounted component.
		const threadId = 'image-thread' as Id<'threadRecords'>;
		// SAFETY: Fixture IDs never leave the mounted component.
		const runId = 'image-run' as Id<'runs'>;
		const text = '![Model screenshot](parse_file/screenshot.png)';

		const message: TranscriptMessage =
			kind === 'persisted'
				? {
						id: 'text:1',
						threadId,
						runId,
						kind: 'text',
						text,
						sequence: 1,
						itemCount: 1,
						pendingTools: 0,
						closed: true,
						revision: 1
					}
				: {
						id: 'live:1',
						threadId,
						runId,
						kind: 'live',
						text,
						runStatus: 'completed',
						runStartedAt: 1,
						parts: kind === 'live-section' ? [{ type: 'text', id: 'image', text }] : []
					};

		const props = {
			userId: 'image-user',
			currentError: null,
			runError: null,
			messages: [message],
			actions: [],
			activeRunId: null
		};

		const { getByRole, rerender } = render(
			<ThreadTranscript
				{...props}
				project={{ repositoryKey: 'repo', displayName: 'Repo', workspacePath: '/workspace' }}
			/>
		);

		const imageUrl = () =>
			new URL(
				getByRole('button', { name: 'View Model screenshot' }).getAttribute('src') ?? '',
				window.location.href
			);

		expect(imageUrl().searchParams.get('userId')).toBe('image-user');
		expect(imageUrl().searchParams.get('threadId')).toBe(threadId);
		expect(imageUrl().searchParams.get('workspacePath')).toBe('/workspace');
		expect(imageUrl().searchParams.get('path')).toBe('parse_file/screenshot.png');
		rerender(<ThreadTranscript {...props} project={null} />);
		expect(imageUrl().searchParams.get('threadId')).toBe(threadId);
		expect(imageUrl().searchParams.get('workspacePath')).toBeNull();
	}
);

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
