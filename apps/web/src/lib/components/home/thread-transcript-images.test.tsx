import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { TranscriptDisplayRow, TranscriptMessage } from '$lib/types/sprocket';
import ThreadTranscript from './thread-transcript';
import { fixtureId } from '$lib/convex-test-client';

it.each(['persisted', 'live-fallback', 'live-section'])(
	"resolves %s model images against the thread's cwd, falling back to the project",
	(kind) => {
		const threadId = fixtureId<'threadRecords'>('image-thread');
		const runId = fixtureId<'runs'>('image-run');

		const text = '![Model screenshot](shots/a.png)';

		const message: TranscriptMessage =
			kind === 'persisted'
				? {
						id: 'text:1',
						threadId,
						runId,
						kind: 'text',
						text,
						sequence: 1,
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
						parts: kind === 'live-section' ? [{ type: 'text', id: 'image', text }] : []
					};

		const props = {
			currentError: null,
			runError: null,
			messages: [message],
			actions: [],
			activeRunId: null
		};

		const project = { repositoryKey: 'repo', displayName: 'Repo', workspacePath: '/workspace' };
		const { getByRole, rerender } = render(<ThreadTranscript {...props} project={project} />);

		const imageUrl = () =>
			new URL(
				getByRole('button', { name: 'View Model screenshot' }).getAttribute('src') ?? '',
				window.location.href
			);

		expect(imageUrl().searchParams.get('workspacePath')).toBe('/workspace');
		expect(imageUrl().searchParams.get('path')).toBe('shots/a.png');
		rerender(<ThreadTranscript {...props} project={project} cwd="/workspace/.worktrees/a" />);
		expect(imageUrl().searchParams.get('workspacePath')).toBe('/workspace/.worktrees/a');
	}
);

it('opens a transcript attachment in the image viewer and restores focus after Escape', async () => {
	const imageUrl = 'https://example.com/board.png';
	const loadAttachment = vi.fn(async () => imageUrl);

	const message = {
		id: 'prompt:1',
		threadId: fixtureId<'threadRecords'>('thread'),
		runId: fixtureId<'runs'>('run'),
		kind: 'prompt',
		text: 'Check this board',
		attachments: [
			{
				storageId: fixtureId<'_storage'>('image'),
				name: 'board.png',
				mediaType: 'image/png',
				size: 100
			}
		],
		sequence: 1,
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
