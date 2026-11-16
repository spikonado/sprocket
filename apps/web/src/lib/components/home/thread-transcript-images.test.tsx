import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, onTestFinished, vi } from 'vitest';
import type {
	TranscriptEvent,
	TranscriptRow,
	TranscriptScopeRequest,
	TranscriptSnapshot,
	WatchHandlers
} from '$lib/types/sprocket';
import { TranscriptStore } from '$lib/home/transcript-store';
import ThreadTranscript from './thread-transcript';
import { fixtureId } from '$lib/convex-test-client';
import { listenOpenMenuDismiss } from '$lib/components/ui/menu-dismiss';

function transcript(rows: TranscriptRow[]) {
	const threadId = fixtureId<'threadRecords'>('image-thread');
	const snapshot: TranscriptSnapshot = { type: 'snapshot', rows, nextBefore: null, stale: false };

	function watch(_request: TranscriptScopeRequest, { signal }: WatchHandlers<TranscriptEvent>) {
		return new Promise<void>((resolve) => {
			if (signal.aborted) resolve();
			else signal.addEventListener('abort', () => resolve(), { once: true });
		});
	}

	const store = new TranscriptStore();
	store.selectThread(threadId);
	onTestFinished(
		store.watch({
			api: {
				fetchTranscriptRows: async () => snapshot,
				fetchTranscriptRow: async ({ rowId }) => {
					const row = rows.find((row) => row.id === rowId);

					if (!row) throw new Error(`Unknown transcript row: ${rowId}`);

					return { row };
				},
				watchTranscript: (_request, handlers) => {
					handlers.onEvent(snapshot);

					return watch(_request, handlers);
				},
				watchTranscriptWork: watch,
				watchTranscriptItem: watch
			},
			userId: 'user',
			threadId,
			isCurrent: () => true
		})
	);

	return store;
}

it.each([false, true])(
	"resolves model images with running=%s against the thread's cwd, falling back to the project",
	(running) => {
		const text = '![Model screenshot](shots/a.png)';

		const store = transcript([{ id: 'text:1', runId: 'run', kind: 'text', text, running }]);

		const props = {
			store,
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

it('opens a transcript attachment in the image viewer and closes only the viewer on Escape', async () => {
	const imageUrl = 'https://example.com/board.png';
	const loadAttachment = vi.fn(async () => imageUrl);

	const message = {
		id: 'prompt:1',
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
		]
	} satisfies TranscriptRow;

	const store = transcript([message]);

	render(
		<ThreadTranscript
			store={store}
			activeRunId={null}
			project={null}
			loadAttachment={loadAttachment}
		/>
	);
	const trigger = await screen.findByRole('button', { name: 'View board.png' });
	expect(loadAttachment).toHaveBeenCalledWith(message.attachments[0].storageId);

	const closeMenu = vi.fn();

	onTestFinished(
		listenOpenMenuDismiss({
			getRoot: () => null,
			onOutside: vi.fn(),
			onEscape: closeMenu
		})
	);

	trigger.focus();
	fireEvent.click(trigger);
	const dialog = screen.getByRole('dialog', { name: 'Image preview: board.png' });
	expect(dialog.querySelector('img')?.src).toBe(imageUrl);
	await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
	fireEvent.keyDown(document, { key: 'Escape' });
	expect(screen.queryByRole('dialog')).toBeNull();
	expect(document.activeElement).toBe(trigger);
	fireEvent.keyDown(document, { key: 'Escape' });
	expect(closeMenu).toHaveBeenCalledOnce();
});
