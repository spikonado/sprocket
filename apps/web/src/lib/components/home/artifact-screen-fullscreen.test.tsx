import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ArtifactEntry } from '$lib/chat/artifacts';
import ArtifactScreenFullscreen from './artifact-screen-fullscreen';

afterEach(() => {
	vi.restoreAllMocks();
	Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
});

it('leaves the artifact open when opening an image exits native fullscreen', async () => {
	const onClose = vi.fn();
	let fullscreen: Element | null = document.documentElement;
	Object.defineProperty(document, 'fullscreenElement', {
		configurable: true,
		get: () => fullscreen
	});
	Object.defineProperty(document, 'exitFullscreen', {
		configurable: true,
		value: vi.fn(async () => {
			fullscreen = null;
			document.dispatchEvent(new Event('fullscreenchange'));
		})
	});

	const { getByRole, queryByRole } = render(
		<ArtifactScreenFullscreen
			artifact={{
				key: 'notes',
				title: 'Notes',
				artifactType: 'markdown',
				content: '![Board](https://example.com/board.png)'
			}}
			fullscreenRequest={Promise.resolve(true)}
			onClose={onClose}
		/>
	);

	await waitFor(() => expect(document.activeElement).toBe(getByRole('dialog')));
	fireEvent.click(getByRole('button', { name: 'View Board' }));

	expect(document.exitFullscreen).toHaveBeenCalledOnce();
	expect(onClose).not.toHaveBeenCalled();
	expect(getByRole('button', { name: 'Exit fullscreen' })).toBeTruthy();
	fireEvent.keyDown(window, { key: 'Escape' });
	expect(queryByRole('dialog', { name: 'Image preview: Board' })).toBeNull();
	fireEvent.keyDown(window, { key: 'Escape' });
	expect(onClose).toHaveBeenCalledOnce();
});

it('resolves images beside the artifact and closes the image before the fullscreen artifact', async () => {
	const onClose = vi.fn();

	const { getByRole, queryByRole } = render(
		<ArtifactScreenFullscreen
			artifact={{
				key: 'notes',
				title: 'Notes',
				artifactType: 'markdown',
				content: '![Board](./board.png)',
				localPath: '/tmp/docs/notes.md'
			}}
			fullscreenRequest={Promise.resolve(false)}
			onClose={onClose}
		/>
	);

	const trigger = getByRole('button', { name: 'View Board' });
	const url = new URL(trigger.getAttribute('src') ?? '', 'http://localhost');

	expect(url.searchParams.get('path')).toBe('/tmp/docs/./board.png');
	await waitFor(() => expect(document.activeElement).toBe(getByRole('dialog')));
	fireEvent.click(trigger);

	expect(getByRole('dialog', { name: 'Image preview: Board' })).toBeTruthy();
	fireEvent.keyDown(window, { key: 'Escape' });

	expect(queryByRole('dialog', { name: 'Image preview: Board' })).toBeNull();
	expect(onClose).not.toHaveBeenCalled();
	fireEvent.keyDown(window, { key: 'Escape' });
	expect(onClose).toHaveBeenCalledOnce();
});

it('offers a close button only when browser fullscreen was refused', async () => {
	const artifact: ArtifactEntry = {
		key: 'notes',
		title: 'Notes',
		artifactType: 'markdown',
		content: 'Hi'
	};

	const granted = render(
		<ArtifactScreenFullscreen
			artifact={artifact}
			fullscreenRequest={Promise.resolve(true)}
			onClose={vi.fn()}
		/>
	);

	await act(async () => {});
	expect(granted.queryByRole('button', { name: 'Exit fullscreen' })).toBeNull();
	granted.unmount();

	const onClose = vi.fn();

	const refused = render(
		<ArtifactScreenFullscreen
			artifact={artifact}
			fullscreenRequest={Promise.resolve(false)}
			onClose={onClose}
		/>
	);

	fireEvent.click(await refused.findByRole('button', { name: 'Exit fullscreen' }));
	expect(onClose).toHaveBeenCalledOnce();
});

it('closes when the browser leaves fullscreen', async () => {
	const onClose = vi.fn();
	render(
		<ArtifactScreenFullscreen
			artifact={{ key: 'notes', title: 'Notes', artifactType: 'markdown', content: 'Hi' }}
			fullscreenRequest={Promise.resolve(true)}
			onClose={onClose}
		/>
	);
	document.dispatchEvent(new Event('fullscreenchange'));
	expect(onClose).toHaveBeenCalledOnce();
});
