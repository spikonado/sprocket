import { useEffect, useState } from 'react';
import { artifactWatchScopeKey } from '$lib/chat/artifacts';
import {
	DEFAULT_SIDE_PANEL_SNAPSHOT,
	isSameOrInside,
	mapPanes,
	mapSplit,
	panesOf,
	removePane,
	renamedPath,
	type FileDraft,
	type SidePanelContentView,
	type SidePanelLayout,
	type SidePanelPane,
	type SidePanelSnapshot,
	type SidePanelTab,
	type SplitDirection
} from '$lib/chat/side-panel';
import { useStore, type Store } from '$lib/store';
import type { ArtifactsWatchRequest, LocalApi, WorkspaceFileTarget } from '$lib/types/sprocket';

type ArtifactLocalApi = Pick<LocalApi, 'watchArtifactSync'>;

export type SidePanelTabPatch = Partial<Omit<SidePanelTab, 'id' | 'view'>> & {
	view?: SidePanelContentView | null;
};

function layoutKeyOf(scope: ArtifactsWatchRequest | null, threadId: string | null) {
	if (threadId) return `thread:${threadId}`;

	return scope ? `draft:${artifactWatchScopeKey(scope)}` : null;
}

export class ArtifactPanel implements Store<number> {
	panel: SidePanelSnapshot = DEFAULT_SIDE_PANEL_SNAPSHOT;
	fullscreenKey: string | null = null;

	#snapshots = new Map<string, SidePanelSnapshot>();
	#layoutKey: string | null = null;
	#nextId = 1;
	#version = 0;
	readonly #listeners = new Set<() => void>();

	getSnapshot = () => this.#version;

	subscribe = (listener: () => void) => {
		this.#listeners.add(listener);

		return () => {
			this.#listeners.delete(listener);
		};
	};

	get layoutKey() {
		return this.#layoutKey;
	}

	/** Artifacts whose content a visible tab or the fullscreen view shows. */
	get shownArtifactKeys() {
		const keys = new Set<string>();

		for (const pane of this.panes) {
			const tab = pane.tabs.find((candidate) => candidate.id === pane.activeTabId);

			if (tab?.view === 'artifacts' && tab.selectedKey) keys.add(tab.selectedKey);
		}

		if (this.fullscreenKey) keys.add(this.fullscreenKey);

		return [...keys].sort();
	}

	get panes() {
		return panesOf(this.panel.layout);
	}

	get tabs() {
		return this.panes.flatMap((pane) => pane.tabs);
	}

	get activePane() {
		const panes = this.panes;

		return panes.find((pane) => pane.id === this.panel.activePaneId) ?? panes[0]!;
	}

	get activeTab() {
		const pane = this.activePane;

		return pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0]!;
	}

	get hasFileDrafts() {
		const hasDraft = (panel: SidePanelSnapshot) =>
			panesOf(panel.layout).some((pane) => pane.tabs.some((tab) => tab.draft));

		return (
			hasDraft(this.panel) ||
			[...this.#snapshots].some(([key, snapshot]) => key !== this.#layoutKey && hasDraft(snapshot))
		);
	}

	selectScope(scope: ArtifactsWatchRequest | null, threadId: string | null) {
		const key = layoutKeyOf(scope, threadId);

		if (key === this.#layoutKey) return;

		if (this.#layoutKey) this.#snapshots.set(this.#layoutKey, this.panel);
		this.#layoutKey = key;
		this.fullscreenKey = null;
		this.panel = (key && this.#snapshots.get(key)) || DEFAULT_SIDE_PANEL_SNAPSHOT;
		this.#emit();
	}

	/** Keeps the local server syncing bound artifact files to Convex while the project is open. */
	watchSync(localApi: ArtifactLocalApi | null, scope: ArtifactsWatchRequest | null) {
		if (!localApi || !scope?.workspacePath) return;
		const ac = new AbortController();

		void localApi.watchArtifactSync(scope, {
			signal: ac.signal,
			onEvent: () => {},
			onError: () => {}
		});

		return () => ac.abort();
	}

	reset() {
		this.#snapshots.clear();
		this.#layoutKey = null;
		this.panel = DEFAULT_SIDE_PANEL_SNAPSHOT;
		this.fullscreenKey = null;
		this.#emit();
	}

	newTab(paneId = this.panel.activePaneId) {
		const pane = this.panes.find((candidate) => candidate.id === paneId) ?? this.activePane;
		const empty = pane.tabs.find((tab) => tab.view === null);

		if (empty) {
			this.activateTab(empty.id);

			return;
		}

		const tab = this.#createTab();
		this.#focus(pane, { tabs: [...pane.tabs, tab], activeTabId: tab.id });
		this.#emit();
	}

	activateTab(id: string) {
		const pane = this.#paneOf(id);

		if (!pane || (this.activePane === pane && pane.activeTabId === id)) return;
		this.#focus(pane, { activeTabId: id });
		this.#emit();
	}

	focusPane(id: string) {
		if (this.panel.activePaneId === id) return;
		this.panel = { ...this.panel, activePaneId: id };
		this.#emit();
	}

	splitPane(id: string, direction: SplitDirection) {
		const tab = this.#createTab();

		const pane: SidePanelPane = {
			type: 'pane',
			id: `pane-${this.#nextId++}`,
			tabs: [tab],
			activeTabId: tab.id
		};

		const splitId = `split-${this.#nextId++}`;

		this.#setPanes((candidate) =>
			candidate.id === id
				? { type: 'split', id: splitId, direction, ratio: 0.5, first: candidate, second: pane }
				: candidate
		);
		this.panel = { ...this.panel, activePaneId: pane.id };
		this.#emit();
	}

	resizeSplit(id: string, ratio: number) {
		this.panel = {
			...this.panel,
			layout: mapSplit(this.panel.layout, id, (split) => ({ ...split, ratio }))
		};
		this.#emit();
	}

	updateTab(id: string, patch: SidePanelTabPatch) {
		this.#setTabs((tab) => (tab.id === id ? { ...tab, ...patch } : tab));
		this.#emit();
	}

	setFileDraft(id: string, draft: FileDraft | undefined) {
		const tab = this.tabs.find((candidate) => candidate.id === id);

		if (!tab) return;
		this.#setTabs((candidate) => (candidate === tab ? { ...tab, draft } : candidate));

		if (!tab.draft !== !draft) this.#emit();
	}

	closeTab(id: string) {
		const pane = this.#paneOf(id);
		const tab = pane?.tabs.find((candidate) => candidate.id === id);

		if (!pane || !tab || tab.view === 'transcript') return;

		const panes = this.panes;
		const index = pane.tabs.indexOf(tab);
		const tabs = pane.tabs.filter((candidate) => candidate !== tab);

		// The transcript tab keeps one pane open, so emptying a pane always leaves another.
		if (tabs.length === 0) {
			const rest = panes.filter((candidate) => candidate !== pane);
			const paneIndex = panes.indexOf(pane);

			const activePaneId =
				this.panel.activePaneId === pane.id
					? rest[Math.min(paneIndex, rest.length - 1)]!.id
					: this.panel.activePaneId;

			this.panel = { ...this.panel, layout: removePane(this.panel.layout, pane.id), activePaneId };
		} else {
			const activeTabId =
				pane.activeTabId === id ? tabs[Math.min(index, tabs.length - 1)]!.id : pane.activeTabId;

			this.#setPanes((candidate) =>
				candidate === pane ? { ...pane, tabs, activeTabId } : candidate
			);
		}

		this.#emit();
	}

	openArtifact(key: string) {
		this.#show(
			this.tabs.find((tab) => tab.view === 'artifacts' && tab.selectedKey === key),
			{ view: 'artifacts', selectedKey: key }
		);
	}

	setFullscreenKey(key: string | null) {
		if (this.fullscreenKey === key) return;
		this.fullscreenKey = key;
		this.#emit();
	}

	openFile(file: WorkspaceFileTarget) {
		const existing = this.tabs.find(
			(tab) =>
				tab.view === 'file' &&
				tab.file?.workspacePath === file.workspacePath &&
				tab.file.path === file.path
		);

		if (existing && this.activeTab === existing) return;
		this.#show(existing, { view: 'file', file });
	}

	openDirectory(directory: WorkspaceFileTarget) {
		this.#show(
			[this.activeTab, ...this.tabs].find((tab) => tab.view === 'files'),
			{ view: 'files', directory }
		);
	}

	renameFile(workspacePath: string, from: string, to: string) {
		let changed = false;

		this.#setTabs((tab) => {
			if (tab.file?.workspacePath !== workspacePath) return tab;
			const path = renamedPath(tab.file.path, from, to);

			if (path === null) return tab;
			changed = true;

			return { ...tab, file: { workspacePath, path } };
		});

		if (changed) this.#emit();
	}

	closeFile(workspacePath: string, path: string) {
		for (const tab of this.tabs) {
			if (tab.file?.workspacePath === workspacePath && isSameOrInside(tab.file.path, path)) {
				this.closeTab(tab.id);
			}
		}
	}

	#createTab(): SidePanelTab {
		return { id: `tab-${this.#nextId++}`, view: null, selectedKey: null };
	}

	#paneOf(tabId: string) {
		return this.panes.find((pane) => pane.tabs.some((tab) => tab.id === tabId));
	}

	#setPanes(map: (pane: SidePanelPane) => SidePanelLayout) {
		this.panel = { ...this.panel, layout: mapPanes(this.panel.layout, map) };
	}

	#setTabs(map: (tab: SidePanelTab) => SidePanelTab) {
		this.#setPanes((pane) => ({ ...pane, tabs: pane.tabs.map(map) }));
	}

	#focus(pane: SidePanelPane, patch: Partial<Pick<SidePanelPane, 'tabs' | 'activeTabId'>>) {
		this.#setPanes((candidate) => (candidate === pane ? { ...pane, ...patch } : candidate));
		this.panel = { ...this.panel, activePaneId: pane.id };
	}

	#show(existing: SidePanelTab | undefined, content: SidePanelTabPatch) {
		const active = this.activeTab;
		const target = existing ?? (active.view === null ? active : this.#createTab());
		const tab = { ...target, ...content };
		const pane = this.#paneOf(target.id) ?? this.activePane;

		this.#focus(pane, {
			tabs: pane.tabs.includes(target)
				? pane.tabs.map((item) => (item === target ? tab : item))
				: [...pane.tabs, tab],
			activeTabId: tab.id
		});
		this.#emit();
	}

	#emit() {
		this.#version += 1;

		for (const listener of this.#listeners) listener();
	}
}

export function useArtifactPanel() {
	const [panel] = useState(() => new ArtifactPanel());
	useStore(panel);

	useEffect(() => {
		const bridge = window.sprocketDesktopBridge;

		// Electron cancels unloads without prompting, so the desktop app asks before quitting instead.
		if (bridge) {
			let reported: boolean | null = null;

			const report = () => {
				if (panel.hasFileDrafts === reported) return;
				reported = panel.hasFileDrafts;
				void bridge.setUnsavedChanges(reported);
			};

			report();

			return panel.subscribe(report);
		}

		const warn = (event: BeforeUnloadEvent) => {
			if (panel.hasFileDrafts) event.preventDefault();
		};

		window.addEventListener('beforeunload', warn);

		return () => window.removeEventListener('beforeunload', warn);
	}, [panel]);

	return panel;
}
