import { act, renderHook } from '@testing-library/react';
import { Text } from '@codemirror/state';
import { expect, it, vi } from 'vitest';
import { ArtifactPanel, useArtifactPanel } from '$lib/home/artifact-panel';

const scope = (repositoryKey: string) => ({
	userId: 'user-a',
	repositoryKey,
	workspacePath: `/worktrees/${repositoryKey}`
});

it('notifies subscribers on panel changes and keeps one instance per mount', () => {
	const { result, rerender } = renderHook(() => useArtifactPanel());
	const instance = result.current;
	const listener = vi.fn<() => void>();
	const unsubscribe = instance.subscribe(listener);
	const before = instance.getSnapshot();

	rerender();
	expect(result.current).toBe(instance);

	act(() => {
		instance.update({ open: true });
	});
	expect(listener).toHaveBeenCalledTimes(1);
	expect(result.current.panel).toMatchObject({ open: true });
	expect(instance.getSnapshot()).not.toBe(before);

	unsubscribe();
});

it('keeps a side panel snapshot per scope and restores it on return', () => {
	const panel = new ArtifactPanel();
	const listener = vi.fn<() => void>();
	panel.subscribe(listener);

	panel.selectScope(scope('robot'));
	panel.update({ expanded: true });
	panel.openArtifact('artifact-1');

	panel.selectScope(scope('other'));
	expect(panel.panel.open).toBe(false);
	expect(panel.fullscreenKey).toBeNull();

	panel.selectScope(scope('robot'));
	expect(panel.panel).toMatchObject({ open: true, expanded: true });
	expect(panel.activeTab).toMatchObject({ view: 'artifacts', selectedKey: 'artifact-1' });
	expect(listener.mock.calls.length).toBeGreaterThanOrEqual(4);

	panel.reset();
	expect(panel.panel.open).toBe(false);
	panel.selectScope(scope('robot'));
	expect(panel.panel.open).toBe(false);
});

it('shows the content of artifacts in visible tabs and fullscreen', () => {
	const panel = new ArtifactPanel();
	panel.openArtifact('artifact-2');
	panel.newTab();
	panel.openArtifact('artifact-1');
	panel.setFullscreenKey('artifact-3');
	expect(panel.shownArtifactKeys).toEqual(['artifact-1', 'artifact-3']);

	panel.setFullscreenKey(null);
	panel.closeTab(panel.activeTab.id);
	expect(panel.shownArtifactKeys).toEqual(['artifact-2']);

	panel.update({ open: false });
	expect(panel.shownArtifactKeys).toEqual([]);
});

it('clears the fullscreen artifact when switching scope or resetting', () => {
	const panel = new ArtifactPanel();
	panel.selectScope(scope('robot'));
	panel.setFullscreenKey('artifact-1');
	expect(panel.fullscreenKey).toBe('artifact-1');

	panel.selectScope(scope('other'));
	expect(panel.fullscreenKey).toBeNull();

	panel.setFullscreenKey('artifact-2');
	panel.reset();
	expect(panel.fullscreenKey).toBeNull();
});

it('opens artifacts in the empty tab, then new tabs, and refocuses tabs already showing them', () => {
	const panel = new ArtifactPanel();
	panel.openArtifact('a');
	panel.openArtifact('b');
	expect(panel.tabs.map((tab) => tab.selectedKey)).toEqual(['a', 'b']);

	panel.openArtifact('a');
	expect(panel.tabs).toHaveLength(2);
	expect(panel.activeTab.selectedKey).toBe('a');

	panel.closeTab(panel.activeTab.id);
	expect(panel.activeTab.selectedKey).toBe('b');
	panel.closeTab(panel.activeTab.id);
	expect(panel.panel.open).toBe(false);
	expect(panel.activeTab.view).toBeNull();
});

it('keeps at most one new tab and focuses it instead of adding another', () => {
	const panel = new ArtifactPanel();
	panel.openArtifact('a');
	panel.newTab();
	const emptyTabId = panel.activeTab.id;

	panel.activateTab(panel.tabs[0]!.id);
	panel.newTab();
	expect(panel.tabs).toHaveLength(2);
	expect(panel.activeTab.id).toBe(emptyTabId);
});

it('opens chat links in the focused pane and refocuses tabs in other panes', () => {
	const panel = new ArtifactPanel();
	panel.openArtifact('a');
	const left = panel.activePane.id;

	panel.splitPane(left, 'row');
	const right = panel.activePane.id;
	expect(panel.panes.map((pane) => pane.id)).toEqual([left, right]);
	expect(panel.activeTab.view).toBeNull();

	panel.openArtifact('b');
	expect(panel.panes.map((pane) => pane.tabs.map((tab) => tab.selectedKey))).toEqual([
		['a'],
		['b']
	]);

	panel.openArtifact('a');
	expect(panel.activePane.id).toBe(left);

	panel.closeTab(panel.activeTab.id);
	expect(panel.panel.layout).toMatchObject({ type: 'pane', id: right });
	expect(panel.activeTab.selectedKey).toBe('b');
});

it('opens files in the empty tab, then new tabs, and keeps them across renames until deleted', () => {
	const panel = new ArtifactPanel();
	const file = { workspacePath: '/repo', path: 'src/main.rs' };
	panel.openFile(file);
	panel.openFile({ workspacePath: '/repo', path: 'README.md' });
	panel.openFile(file);
	expect(panel.tabs.map((tab) => tab.file?.path)).toEqual(['src/main.rs', 'README.md']);
	expect(panel.activeTab.file).toEqual(file);
	expect(panel.panel.open).toBe(true);

	panel.renameFile('/repo', 'src', 'lib');
	expect(panel.activeTab.file).toEqual({ workspacePath: '/repo', path: 'lib/main.rs' });

	panel.closeFile('/repo', 'lib');
	expect(panel.tabs.map((tab) => tab.file?.path)).toEqual(['README.md']);
});

it('shows linked folders in one files tab', () => {
	const panel = new ArtifactPanel();
	panel.openDirectory({ workspacePath: '/repo', path: 'src' });
	panel.openFile({ workspacePath: '/repo', path: 'README.md' });
	panel.openDirectory({ workspacePath: '/tmp/build', path: '' });

	expect(panel.panel.open).toBe(true);
	expect(panel.tabs.map((tab) => tab.view)).toEqual(['files', 'file']);
	expect(panel.activeTab.directory).toEqual({ workspacePath: '/tmp/build', path: '' });
});

it('reports unsaved file edits in any scope until they are saved', () => {
	const panel = new ArtifactPanel();
	const doc = Text.of(['edited']);

	panel.selectScope(scope('robot'));
	panel.openFile({ workspacePath: '/repo', path: 'notes.txt' });
	panel.setFileDraft(panel.activeTab.id, { doc, base: Text.of(['saved']), version: 'v1' });
	panel.selectScope(scope('other'));
	expect(panel.hasFileDrafts).toBe(true);

	panel.selectScope(scope('robot'));
	panel.setFileDraft(panel.activeTab.id, undefined);
	expect(panel.hasFileDrafts).toBe(false);
});

it('tells the desktop app when unsaved file edits appear and go away', () => {
	const setUnsavedChanges = vi.fn<(value: boolean) => Promise<void>>(async () => {});

	window.sprocketDesktopBridge = {
		takeWorkspaceLaunch: async () => null,
		onWorkspaceLaunch: () => () => {},
		openExternal: async () => {},
		focusWindow: async () => true,
		setUnsavedChanges,
		updates: {
			getState: vi.fn(),
			download: vi.fn(),
			install: vi.fn(),
			onState: () => () => {}
		}
	};

	const { result, unmount } = renderHook(() => useArtifactPanel());
	const panel = result.current;

	act(() => {
		panel.openFile({ workspacePath: '/repo', path: 'notes.txt' });
		panel.setFileDraft(panel.activeTab.id, {
			doc: Text.of(['edited']),
			base: Text.of(['saved']),
			version: 'v1'
		});
		panel.setFileDraft(panel.activeTab.id, undefined);
	});
	unmount();
	delete window.sprocketDesktopBridge;

	expect(setUnsavedChanges.mock.calls).toEqual([[false], [true], [false]]);
});
