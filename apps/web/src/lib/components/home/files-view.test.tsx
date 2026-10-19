import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import FilesView, { type FilesApi } from './files-view';
import type { WorkspaceFilesResult } from '$lib/types/sprocket';

const listing: WorkspaceFilesResult = {
	paths: ['src/', 'src/main.rs', 'README.md'],
	gitStatus: [{ path: 'src/main.rs', status: 'modified' }],
	scanning: false,
	truncated: false,
	hash: 'h1',
	unchanged: false
};

function filesApi(): FilesApi {
	return {
		listWorkspaceFiles: vi.fn(async () => listing),
		createWorkspaceFile: vi.fn(async () => {}),
		renameWorkspaceFile: vi.fn(async () => {}),
		deleteWorkspaceFile: vi.fn(async () => {})
	};
}

function renderFiles(api: FilesApi, onOpenFile = vi.fn(), threadCwd = '/repo-worktree') {
	render(
		<FilesView
			api={api}
			projectPath="/repo"
			threadCwd={threadCwd}
			active
			onOpenFile={onOpenFile}
			onRenamed={vi.fn()}
			onDeleted={vi.fn()}
		/>
	);
}

function row(path: string) {
	return document
		.querySelector('file-tree-container')
		?.shadowRoot?.querySelector<HTMLElement>(`[role="treeitem"][data-item-path="${path}"]`);
}

it('switches roots with the arrow keys', async () => {
	const api = filesApi();
	renderFiles(api);

	await waitFor(() =>
		expect(api.listWorkspaceFiles).toHaveBeenLastCalledWith(
			{ workspacePath: '/repo-worktree', knownHash: undefined },
			expect.any(AbortSignal)
		)
	);

	fireEvent.keyDown(screen.getByRole('radio', { name: 'Thread' }), { key: 'ArrowRight' });
	await waitFor(() =>
		expect(api.listWorkspaceFiles).toHaveBeenLastCalledWith(
			{ workspacePath: '/repo', knownHash: undefined },
			expect.any(AbortSignal)
		)
	);
	expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Project' }));
	expect(screen.getByRole('radio', { name: 'Project' }).tabIndex).toBe(0);
});

it('lists the project without a root switch when the thread runs in it', async () => {
	const api = filesApi();
	renderFiles(api, vi.fn(), '/repo');

	await waitFor(() =>
		expect(api.listWorkspaceFiles).toHaveBeenCalledWith(
			{ workspacePath: '/repo', knownHash: undefined },
			expect.any(AbortSignal)
		)
	);
	expect(screen.queryByRole('radiogroup')).toBeNull();
});

it('keeps expanded folders across a refresh and opens clicked files', async () => {
	const api = filesApi();
	const onOpenFile = vi.fn();
	renderFiles(api, onOpenFile);

	await waitFor(() => expect(row('src/')).toBeTruthy());
	fireEvent.click(row('src/')!);
	await waitFor(() => expect(row('src/main.rs')).toBeTruthy());

	vi.mocked(api.listWorkspaceFiles).mockResolvedValue({
		...listing,
		paths: [...listing.paths, 'src/lib.rs'],
		hash: 'h2'
	});
	fireEvent.click(screen.getByRole('button', { name: 'Refresh files' }));
	await waitFor(() => expect(row('src/lib.rs')).toBeTruthy());
	expect(row('src/')?.getAttribute('aria-expanded')).toBe('true');

	fireEvent.click(row('src/lib.rs')!);
	expect(onOpenFile).toHaveBeenCalledWith({ workspacePath: '/repo-worktree', path: 'src/lib.rs' });
});
