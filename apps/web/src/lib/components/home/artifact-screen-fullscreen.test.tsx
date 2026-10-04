import { fireEvent, render, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import ArtifactScreenFullscreen from './artifact-screen-fullscreen';

it('resolves images beside the artifact and closes the image before the fullscreen artifact', async () => {
	const onClose = vi.fn();

	const { getByRole, queryByRole } = render(
		<ArtifactScreenFullscreen
			artifact={{
				key: 'notes',
				title: 'Notes',
				artifactType: 'markdown',
				content: '![Board](./board.png)',
				localPath: '/workspace/docs/notes.md'
			}}
			workspacePath="/workspace"
			onClose={onClose}
		/>
	);

	const trigger = getByRole('button', { name: 'View Board' });
	const url = new URL(trigger.getAttribute('src') ?? '', 'http://localhost');

	expect(url.searchParams.get('path')).toBe('/workspace/docs/./board.png');
	await waitFor(() => expect(document.activeElement).toBe(getByRole('dialog')));
	fireEvent.click(trigger);

	expect(getByRole('dialog', { name: 'Image preview: Board' })).toBeTruthy();
	fireEvent.keyDown(window, { key: 'Escape' });

	expect(queryByRole('dialog', { name: 'Image preview: Board' })).toBeNull();
	expect(onClose).not.toHaveBeenCalled();
	fireEvent.keyDown(window, { key: 'Escape' });
	expect(onClose).toHaveBeenCalledOnce();
});
