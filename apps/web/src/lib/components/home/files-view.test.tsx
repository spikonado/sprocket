import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import FilesView from './files-view';

it('lists the thread cwd and switches to the project root', async () => {
	const listWorkspaceFiles = vi.fn(async () => ({
		paths: ['src/', 'src/main.rs'],
		scanning: false,
		truncated: false
	}));

	render(
		<FilesView api={{ listWorkspaceFiles }} projectPath="/repo" threadCwd="/repo-worktree" active />
	);

	await waitFor(() =>
		expect(listWorkspaceFiles).toHaveBeenLastCalledWith(
			{ workspacePath: '/repo-worktree' },
			expect.any(AbortSignal)
		)
	);
	await waitFor(() => expect(screen.queryByText('Loading files…')).toBeNull());

	fireEvent.click(screen.getByRole('radio', { name: 'Project' }));
	await waitFor(() =>
		expect(listWorkspaceFiles).toHaveBeenLastCalledWith(
			{ workspacePath: '/repo' },
			expect.any(AbortSignal)
		)
	);
	expect(screen.getByTitle('/repo')).toBeTruthy();
});
