import { act, renderHook } from '@testing-library/react';
import { Text } from '@codemirror/state';
import { expect, it, vi } from 'vitest';
import { api } from '@convex/_generated/api';
import {
	ArtifactPanel,
	createConvexArtifactClient,
	useArtifactPanel,
	type ConvexArtifactClient
} from '$lib/home/artifact-panel';

function createFakeClient(readRevision: () => number | undefined) {
	const listeners = new Set<() => void>();
	const disposed = vi.fn<() => void>();

	const watch: ReturnType<ConvexArtifactClient['watchQuery']> = {
		onUpdate: (callback) => {
			listeners.add(callback);

			return () => {
				listeners.delete(callback);
				disposed();
			};
		},
		localQueryResult: readRevision
	};

	const watchQuery = vi.fn<ConvexArtifactClient['watchQuery']>(() => watch);

	const client: ConvexArtifactClient = {
		query: async () => ({ page: [], isDone: true, continueCursor: '', revision: 0 }),
		watchQuery
	};

	return {
		client,
		disposed,
		watchQuery,
		notify: () => {
			for (const listener of listeners) listener();
		}
	};
}

const scope = (repositoryKey: string) => ({
	userId: 'user-a',
	repositoryKey,
	workspacePath: `/worktrees/${repositoryKey}`
});

it('delivers the current registry revision immediately and on every change', () => {
	let revision = 7;
	const fake = createFakeClient(() => revision);
	const onUpdate = vi.fn<(revision: number) => void>();
	const onError = vi.fn<(error: Error) => void>();

	const unsubscribe = createConvexArtifactClient(fake.client).onUpdate(
		api.artifacts.getArtifactState,
		{ repositoryKey: 'github.com/acme/robot' },
		onUpdate,
		onError
	);

	expect(fake.watchQuery).toHaveBeenCalledWith(api.artifacts.getArtifactState, {
		repositoryKey: 'github.com/acme/robot'
	});
	expect(onUpdate).toHaveBeenCalledWith(7);

	revision = 8;
	fake.notify();
	expect(onUpdate).toHaveBeenLastCalledWith(8);
	expect(onError).not.toHaveBeenCalled();

	unsubscribe();
	expect(fake.disposed).toHaveBeenCalledTimes(1);
});

it('surfaces registry failures without throwing at the caller', () => {
	const fake = createFakeClient(() => {
		throw new Error('Artifact registry unavailable.');
	});

	const onUpdate = vi.fn<(revision: number) => void>();
	const onError = vi.fn<(error: Error) => void>();

	createConvexArtifactClient(fake.client).onUpdate(
		api.artifacts.getArtifactState,
		{ repositoryKey: 'github.com/acme/robot' },
		onUpdate,
		onError
	);
	fake.notify();

	expect(onUpdate).not.toHaveBeenCalled();
	expect(onError).toHaveBeenCalledWith(new Error('Artifact registry unavailable.'));
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
	expect(panel.panel.tabs.map((tab) => tab.selectedKey)).toEqual(['a', 'b']);

	panel.openArtifact('a');
	expect(panel.panel.tabs).toHaveLength(2);
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

	panel.activateTab(panel.panel.tabs[0]!.id);
	panel.newTab();
	expect(panel.panel.tabs).toHaveLength(2);
	expect(panel.activeTab.id).toBe(emptyTabId);
});

it('opens each file once and keeps its tab across renames until it is deleted', () => {
	const panel = new ArtifactPanel();
	const file = { workspacePath: '/repo', path: 'src/main.rs' };
	panel.openFile(file);
	panel.openFile({ workspacePath: '/repo', path: 'README.md' });
	panel.openFile(file);
	expect(panel.panel.tabs.filter((tab) => tab.view === 'file')).toHaveLength(2);
	expect(panel.activeTab.file).toEqual(file);
	expect(panel.panel.open).toBe(true);

	panel.renameFile('/repo', 'src', 'lib');
	expect(panel.activeTab.file).toEqual({ workspacePath: '/repo', path: 'lib/main.rs' });

	panel.closeFile('/repo', 'lib');
	expect(panel.panel.tabs.map((tab) => tab.file?.path)).toEqual([undefined, 'README.md']);
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
