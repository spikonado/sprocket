import { fireEvent, render, screen } from '@testing-library/react';
import { useEffect, type ComponentProps } from 'react';
import { expect, it, vi } from 'vitest';
import SidePanel from './side-panel';
import { useArtifactPanel } from '$lib/home/artifact-panel';
import type { LocalApi, WorkspaceFileTarget } from '$lib/types/sprocket';

const artifact = {
	key: 'notes',
	title: 'Notes',
	artifactType: 'markdown',
	content: '# Notes'
} as const;

type FilesApi = ComponentProps<typeof SidePanel>['filesApi'];

function Harness({ filesApi = null, file }: { filesApi?: FilesApi; file?: WorkspaceFileTarget }) {
	const panel = useArtifactPanel();

	useEffect(() => {
		if (file) panel.openFile(file);
	}, [panel, file]);

	return (
		<SidePanel
			artifacts={[artifact]}
			layout={panel.panel.layout}
			activePaneId={panel.activePane.id}
			browserApi={null}
			filesApi={filesApi}
			expanded={false}
			onNewTab={(paneId) => panel.newTab(paneId)}
			onActivateTab={(id) => panel.activateTab(id)}
			onCloseTab={(id) => panel.closeTab(id)}
			onUpdateTab={(id, patch) => panel.updateTab(id, patch)}
			onDraftChange={(id, draft) => panel.setFileDraft(id, draft)}
			onFocusPane={(id) => panel.focusPane(id)}
			onSplitPane={(id, direction) => panel.splitPane(id, direction)}
			onResizeSplit={(id, ratio) => panel.resizeSplit(id, ratio)}
			onOpenFile={(file) => panel.openFile(file)}
			onOpenTscircuit={(file) => panel.openFile(file, 'tscircuit')}
			onFileRenamed={(workspacePath, from, to) => panel.renameFile(workspacePath, from, to)}
			onFileDeleted={(workspacePath, path) => panel.closeFile(workspacePath, path)}
			onOpenFullscreen={vi.fn()}
			onToggleExpanded={vi.fn()}
			onClose={vi.fn()}
		/>
	);
}

it('opens a circuit file in the tscircuit editor', async () => {
	const url = 'https://sprocket.test/api/tscircuit/dev/ab12/#file=board.circuit.tsx';
	const startTscircuit = vi.fn<LocalApi['startTscircuit']>(async () => url);
	const pending = () => new Promise<never>(() => {});

	const filesApi: FilesApi = {
		listWorkspaceFiles: pending,
		createWorkspaceFile: pending,
		renameWorkspaceFile: pending,
		deleteWorkspaceFile: pending,
		readWorkspaceFile: pending,
		writeWorkspaceFile: pending,
		startTscircuit
	};

	const file = { workspacePath: '/w', path: 'pcb/board.circuit.tsx' };

	render(<Harness filesApi={filesApi} file={file} />);

	fireEvent.click(await screen.findByRole('button', { name: 'Open in tscircuit' }));
	expect((await screen.findByTitle('tscircuit editor')).getAttribute('src')).toBe(url);
	expect(startTscircuit).toHaveBeenCalledWith(file, expect.any(AbortSignal));
	expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
		'board.circuit.tsx',
		'board.circuit.tsx'
	]);
});

it('keeps each tab open with its own view and switches between them', () => {
	render(<Harness />);
	fireEvent.click(screen.getByRole('button', { name: 'Artifacts' }));
	expect(document.activeElement).toBe(screen.getByRole('tabpanel', { name: 'Artifacts' }));
	fireEvent.click(screen.getByText('Notes'));

	fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
	fireEvent.click(screen.getByRole('button', { name: 'Browser' }));
	expect(document.activeElement).toBe(screen.getByRole('tabpanel', { name: 'Browser' }));
	expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Notes', 'Browser']);

	fireEvent.click(screen.getByRole('tab', { name: 'Notes' }));
	expect(screen.getByRole('tab', { name: 'Notes' }).getAttribute('aria-selected')).toBe('true');
	expect(screen.getByRole('tabpanel', { name: 'Notes' })).toBeTruthy();

	fireEvent.keyDown(screen.getByRole('tab', { name: 'Notes' }), { key: 'ArrowRight' });
	expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Browser' }));
	fireEvent.keyDown(screen.getByRole('tab', { name: 'Browser' }), { key: 'ArrowRight' });
	expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Notes' }));

	fireEvent.click(screen.getByRole('button', { name: 'Close Notes tab' }));
	expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Browser']);
	expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Browser' }));
});

it('splits panes right and down, each with its own tabs, and closes empty panes', () => {
	render(<Harness />);
	fireEvent.click(screen.getByRole('button', { name: 'Artifacts' }));
	fireEvent.click(screen.getByRole('button', { name: 'Split right' }));
	expect(screen.getAllByRole('tablist')).toHaveLength(2);
	expect(screen.getAllByRole('separator', { name: 'Resize panes side by side' })).toHaveLength(1);

	const [, right] = screen.getAllByRole('tablist');
	expect(right!.textContent).toBe('New tab');
	expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'New tab' }));
	fireEvent.click(screen.getByRole('button', { name: 'Browser' }));
	expect(screen.getAllByRole('tabpanel')).toHaveLength(2);

	fireEvent.click(screen.getAllByRole('button', { name: 'Split down' })[1]!);
	expect(screen.getAllByRole('tablist')).toHaveLength(3);
	expect(screen.getByRole('separator', { name: 'Resize stacked panes' })).toBeTruthy();
	expect(screen.getAllByRole('button', { name: 'Close panel' })).toHaveLength(1);

	fireEvent.click(screen.getByRole('button', { name: 'Close New tab tab' }));
	fireEvent.click(screen.getByRole('button', { name: 'Close Browser tab' }));
	expect(screen.getAllByRole('tablist')).toHaveLength(1);
	expect(screen.queryByRole('separator')).toBeNull();
	expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Artifacts']);
	expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Artifacts' }));
});
