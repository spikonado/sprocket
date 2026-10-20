import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import FilesView, { type FilesApi } from './files-view';
import type { WorkspaceFileTarget, WorkspaceFilesResult } from '$lib/types/sprocket';

const listing: WorkspaceFilesResult = {
	paths: ['src/', 'src/main.rs', 'README.md'],
	gitStatus: [{ path: 'src/main.rs', status: 'modified' }],
	scanning: false,
	truncated: false,
	hash: 'h1'
};

function filesApi(): FilesApi {
	return {
		listWorkspaceFiles: vi.fn(async () => listing),
		createWorkspaceFile: vi.fn(async () => {}),
		renameWorkspaceFile: vi.fn(async () => {}),
		deleteWorkspaceFile: vi.fn(async () => {})
	};
}

function renderFiles(
	api: FilesApi,
	onOpenFile = vi.fn(),
	threadCwd = '/repo-worktree',
	location?: WorkspaceFileTarget,
	onLocationChange = vi.fn()
) {
	render(
		<FilesView
			api={api}
			projectPath="/repo"
			threadCwd={threadCwd}
			location={location}
			onLocationChange={onLocationChange}
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

it('switches between the thread and project roots', async () => {
	const api = filesApi();
	renderFiles(api);

	await waitFor(() =>
		expect(api.listWorkspaceFiles).toHaveBeenLastCalledWith(
			{ workspacePath: '/repo-worktree', knownHash: undefined },
			expect.any(AbortSignal)
		)
	);

	fireEvent.click(screen.getByRole('button', { name: 'Project' }));
	await waitFor(() =>
		expect(api.listWorkspaceFiles).toHaveBeenLastCalledWith(
			{ workspacePath: '/repo', knownHash: undefined },
			expect.any(AbortSignal)
		)
	);
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
	expect(screen.queryByRole('group', { name: 'Files root' })).toBeNull();
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

it('reveals a linked folder inside the thread root', async () => {
	renderFiles(filesApi(), vi.fn(), '/repo-worktree', {
		workspacePath: '/repo-worktree',
		path: 'src'
	});

	await waitFor(() => expect(row('src/main.rs')).toBeTruthy());
	expect(row('src/')?.getAttribute('aria-expanded')).toBe('true');
});

it('browses a linked folder outside the workspace until asked to go back', async () => {
	const api = filesApi();
	const onLocationChange = vi.fn();
	renderFiles(
		api,
		vi.fn(),
		'/repo-worktree',
		{ workspacePath: '/tmp/build', path: '' },
		onLocationChange
	);

	await waitFor(() =>
		expect(api.listWorkspaceFiles).toHaveBeenLastCalledWith(
			{ workspacePath: '/tmp/build', knownHash: undefined },
			expect.any(AbortSignal)
		)
	);
	expect(screen.getByRole('button', { name: 'Thread' }).getAttribute('aria-pressed')).toBe('false');

	fireEvent.click(screen.getByRole('button', { name: 'Back to workspace files' }));
	expect(onLocationChange).toHaveBeenCalledWith(undefined);
});
