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
		instance.openArtifact('artifact-1');
	});
	expect(listener).toHaveBeenCalledTimes(1);
	expect(result.current.activeTab).toMatchObject({ view: 'artifacts', selectedKey: 'artifact-1' });
	expect(instance.getSnapshot()).not.toBe(before);

	unsubscribe();
});

it('keeps a layout per thread in the same scope and restores it on return', () => {
	const panel = new ArtifactPanel();

	panel.selectScope(scope('robot'), 'thread-a');
	panel.openArtifact('artifact-1');
	panel.splitPane(panel.activePane.id, 'row');
	const layout = panel.panel;

	panel.selectScope(scope('robot'), 'thread-b');
	expect(panel.tabs.map((tab) => tab.view)).toEqual(['transcript']);
	expect(panel.fullscreenKey).toBeNull();
	panel.openFile({ workspacePath: '/repo', path: 'README.md' });

	panel.selectScope(scope('robot'), 'thread-a');
	expect(panel.panel).toBe(layout);
	panel.selectScope(scope('moved-project'), 'thread-a');
	expect(panel.panel).toBe(layout);

	panel.selectScope(scope('robot'), 'thread-b');
	expect(panel.activeTab.file).toEqual({ workspacePath: '/repo', path: 'README.md' });

	panel.reset();
	panel.selectScope(scope('robot'), 'thread-a');
	expect(panel.tabs.map((tab) => tab.view)).toEqual(['transcript']);
});

it('keeps the transcript tab when closing tabs', () => {
	const panel = new ArtifactPanel();
	const transcript = panel.activeTab;
	panel.openArtifact('a');
	panel.splitPane(panel.activePane.id, 'row');
	panel.openArtifact('b');

	panel.closeTab(transcript.id);
	panel.closeTab(panel.activeTab.id);
	panel.closeTab(panel.tabs[1]!.id);

	expect(panel.panel.layout).toMatchObject({ type: 'pane', tabs: [transcript] });
	expect(panel.activeTab).toBe(transcript);
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

	panel.activateTab(panel.tabs[0]!.id);
	expect(panel.shownArtifactKeys).toEqual([]);
});

it('clears the fullscreen artifact when switching scope or resetting', () => {
	const panel = new ArtifactPanel();
	panel.selectScope(scope('robot'), 'thread-a');
	panel.setFullscreenKey('artifact-1');
	expect(panel.fullscreenKey).toBe('artifact-1');

	panel.selectScope(scope('other'), 'thread-b');
	expect(panel.fullscreenKey).toBeNull();

	panel.setFullscreenKey('artifact-2');
	panel.reset();
	expect(panel.fullscreenKey).toBeNull();
});

it('opens artifacts in the empty tab, then new tabs, and refocuses tabs already showing them', () => {
	const panel = new ArtifactPanel();
	panel.newTab();
	panel.openArtifact('a');
	panel.openArtifact('b');
	expect(panel.tabs.map((tab) => tab.view)).toEqual(['transcript', 'artifacts', 'artifacts']);
	expect(panel.tabs.map((tab) => tab.selectedKey)).toEqual([null, 'a', 'b']);

	panel.openArtifact('a');
	expect(panel.tabs).toHaveLength(3);
	expect(panel.activeTab.selectedKey).toBe('a');

	panel.closeTab(panel.activeTab.id);
	expect(panel.activeTab.selectedKey).toBe('b');
	panel.closeTab(panel.activeTab.id);
	expect(panel.activeTab.view).toBe('transcript');
});

it('keeps at most one new tab and focuses it instead of adding another', () => {
	const panel = new ArtifactPanel();
	panel.openArtifact('a');
	panel.newTab();
	const emptyTabId = panel.activeTab.id;

	panel.activateTab(panel.tabs[0]!.id);
	panel.newTab();
	expect(panel.tabs).toHaveLength(3);
	expect(panel.activeTab.id).toBe(emptyTabId);
});

it('opens chat links in the focused pane, refocuses tabs in other panes, and removes emptied panes', () => {
	const panel = new ArtifactPanel();
	panel.openArtifact('a');
	const left = panel.activePane.id;

	panel.splitPane(left, 'row');
	const right = panel.activePane.id;
	expect(panel.panes.map((pane) => pane.id)).toEqual([left, right]);
	expect(panel.activeTab.view).toBeNull();

	panel.openArtifact('b');
	expect(panel.panes.map((pane) => pane.tabs.map((tab) => tab.selectedKey))).toEqual([
		[null, 'a'],
		['b']
	]);

	panel.openArtifact('a');
	expect(panel.activePane.id).toBe(left);

	panel.openArtifact('b');
	panel.closeTab(panel.activeTab.id);
	expect(panel.panel.layout).toMatchObject({ type: 'pane', id: left });
	expect(panel.activeTab.selectedKey).toBe('a');
});

it('opens files in new tabs and keeps them across renames until deleted', () => {
	const panel = new ArtifactPanel();
	const file = { workspacePath: '/repo', path: 'src/main.rs' };
	panel.openFile(file);
	panel.openFile({ workspacePath: '/repo', path: 'README.md' });
	panel.openFile(file);
	expect(panel.tabs.map((tab) => tab.file?.path)).toEqual([undefined, 'src/main.rs', 'README.md']);
	expect(panel.activeTab.file).toEqual(file);

	panel.renameFile('/repo', 'src', 'lib');
	expect(panel.activeTab.file).toEqual({ workspacePath: '/repo', path: 'lib/main.rs' });

	panel.closeFile('/repo', 'lib');
	expect(panel.tabs.map((tab) => tab.file?.path)).toEqual([undefined, 'README.md']);
});

it('shows linked folders in one files tab', () => {
	const panel = new ArtifactPanel();
	panel.openDirectory({ workspacePath: '/repo', path: 'src' });
	panel.openFile({ workspacePath: '/repo', path: 'README.md' });
	panel.openDirectory({ workspacePath: '/tmp/build', path: '' });

	expect(panel.tabs.map((tab) => tab.view)).toEqual(['transcript', 'files', 'file']);
	expect(panel.activeTab.directory).toEqual({ workspacePath: '/tmp/build', path: '' });
});

it('keeps unsaved file edits per thread and reports them until they are saved', () => {
	const panel = new ArtifactPanel();
	const doc = Text.of(['edited']);

	panel.selectScope(scope('robot'), 'thread-a');
	panel.openFile({ workspacePath: '/repo', path: 'notes.txt' });
	panel.setFileDraft(panel.activeTab.id, { doc, base: Text.of(['saved']), version: 'v1' });
	const tabId = panel.activeTab.id;
	panel.selectScope(scope('robot'), 'thread-b');
	expect(panel.hasFileDrafts).toBe(true);

	panel.selectScope(scope('robot'), 'thread-a');
	expect(panel.activeTab.draft?.doc).toBe(doc);
	panel.selectScope(scope('robot'), 'thread-b');
	panel.setFileDraft(tabId, undefined);
	expect(panel.hasFileDrafts).toBe(false);
	panel.selectScope(scope('robot'), 'thread-a');
	expect(panel.activeTab.draft).toBeUndefined();
});

it('keeps file renames and deletions consistent across thread layouts', () => {
	const panel = new ArtifactPanel();
	panel.selectScope(scope('robot'), 'thread-a');
	panel.splitPane(panel.activePane.id, 'row');
	panel.openFile({ workspacePath: '/repo', path: 'src/notes.txt' });
	panel.setFileDraft(panel.activeTab.id, {
		doc: Text.of(['edited']),
		base: Text.of(['saved']),
		version: 'v1'
	});
	panel.selectScope(scope('robot'), 'thread-b');
	panel.openFile({ workspacePath: '/repo', path: 'src/notes.txt' });
	panel.renameFile('/repo', 'src', 'lib');
	expect(panel.activeTab.file?.path).toBe('lib/notes.txt');
	panel.selectScope(scope('robot'), 'thread-a');
	expect(panel.activeTab.file?.path).toBe('lib/notes.txt');
	expect(panel.activeTab.draft?.doc.toString()).toBe('edited');
	panel.selectScope(scope('robot'), 'thread-b');
	panel.closeFile('/repo', 'lib');
	panel.selectScope(scope('robot'), 'thread-a');
	expect(panel.panes).toHaveLength(1);
	expect(panel.activeTab.view).toBe('transcript');
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
