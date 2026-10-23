import { useEffect, useState } from 'react';
import type { Watch } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { api } from '@convex/_generated/api';
import {
	EMPTY_ARTIFACT_WATCH_STATE,
	applyArtifactsWatchEvent,
	artifactEntryFromLocal,
	artifactWatchScopeKey,
	isCurrentArtifactsWatch,
	mergeArtifactSources,
	type ArtifactWatchState
} from '$lib/chat/artifacts';
import { watchCloudArtifacts, type CloudArtifactScope } from '$lib/chat/cloud-artifacts';
import {
	DEFAULT_SIDE_PANEL_SNAPSHOT,
	isSameOrInside,
	mapPanes,
	mapSplit,
	panesOf,
	renamedPath,
	type FileDraft,
	type SidePanelLayout,
	type SidePanelPane,
	type SidePanelSnapshot,
	type SidePanelTab,
	type SplitDirection
} from '$lib/chat/side-panel';
import { useStore, type Store } from '$lib/store';
import type { ArtifactsWatchRequest, LocalApi, WorkspaceFileTarget } from '$lib/types/sprocket';

type ArtifactClient = Parameters<typeof watchCloudArtifacts>[0];

type ArtifactLocalApi = Pick<LocalApi, 'watchArtifacts'>;

type ArtifactRegistryQuery = typeof api.artifacts.listArtifacts;

type ArtifactStateQuery = typeof api.artifacts.getArtifactState;

export type ConvexArtifactClient = {
	query: (
		query: ArtifactRegistryQuery,
		args: FunctionArgs<ArtifactRegistryQuery>
	) => Promise<FunctionReturnType<ArtifactRegistryQuery>>;
	watchQuery: (
		query: ArtifactStateQuery,
		args: Pick<FunctionArgs<ArtifactStateQuery>, 'repositoryKey'>
	) => Pick<Watch<FunctionReturnType<ArtifactStateQuery>>, 'localQueryResult' | 'onUpdate'>;
};

export class ArtifactPanel implements Store<number> {
	watchState: ArtifactWatchState = { ...EMPTY_ARTIFACT_WATCH_STATE };
	panel: SidePanelSnapshot = { ...DEFAULT_SIDE_PANEL_SNAPSHOT };
	fullscreenKey: string | null = null;

	#watchGeneration = 0;
	#watchScope: string | null = null;
	#snapshots = new Map<string, SidePanelSnapshot>();
	#panelScopeKey: string | null = null;
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

	get artifacts() {
		return this.watchState.artifacts.map(artifactEntryFromLocal);
	}

	get fullscreenArtifact() {
		return this.artifacts.find((artifact) => artifact.key === this.fullscreenKey) ?? null;
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

		// The current scope's snapshot is stale until the panel leaves it again.
		return (
			hasDraft(this.panel) ||
			[...this.#snapshots].some(
				([scopeKey, snapshot]) => scopeKey !== this.#panelScopeKey && hasDraft(snapshot)
			)
		);
	}

	selectScope(scope: ArtifactsWatchRequest | null) {
		const scopeKey = scope ? artifactWatchScopeKey(scope) : null;

		if (scopeKey === this.#panelScopeKey) return;

		if (this.#panelScopeKey) this.#snapshots.set(this.#panelScopeKey, this.panel);
		this.#panelScopeKey = scopeKey;
		this.fullscreenKey = null;
		this.panel = {
			...((scopeKey && this.#snapshots.get(scopeKey)) || DEFAULT_SIDE_PANEL_SNAPSHOT)
		};
		this.#emit();
	}

	watch(args: {
		localApi: ArtifactLocalApi | null;
		artifactClient: ArtifactClient;
		cloudReady: boolean;
		scope: ArtifactsWatchRequest | null;
	}) {
		const generation = ++this.#watchGeneration;
		this.watchState = { ...EMPTY_ARTIFACT_WATCH_STATE };
		this.#emit();

		if (!args.scope) {
			this.#watchScope = null;

			return;
		}

		const scopeKey = artifactWatchScopeKey(args.scope);
		this.#watchScope = scopeKey;
		const ac = new AbortController();
		let cloud: ArtifactWatchState = { artifacts: [], stale: true, error: null };
		let local: ArtifactWatchState | null = null;

		const publish = () => {
			if (ac.signal.aborted || generation !== this.#watchGeneration) return;
			this.watchState = mergeArtifactSources(cloud, local);
			this.#emit();
		};

		const cloudScope: CloudArtifactScope = {
			userId: args.scope.userId,
			repositoryKey: args.scope.repositoryKey
		};

		const stopCloud = args.cloudReady
			? watchCloudArtifacts(args.artifactClient, cloudScope, (snapshot) => {
					cloud = snapshot;
					publish();
				})
			: () => {};

		void this.#watchLocal(args.localApi, args.scope.workspacePath, args.scope, {
			ac,
			generation,
			scopeKey,
			setLocal: (next) => {
				local = next;
				publish();
			}
		});

		return () => {
			ac.abort();
			stopCloud();
		};
	}

	reset() {
		this.#snapshots.clear();
		this.#panelScopeKey = null;
		this.#watchScope = null;
		this.panel = { ...DEFAULT_SIDE_PANEL_SNAPSHOT };
		this.fullscreenKey = null;
		this.#emit();
	}

	update(patch: Partial<Pick<SidePanelSnapshot, 'open' | 'expanded'>>) {
		this.panel = { ...this.panel, ...patch };
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

	/** Splits the pane in two; the new pane opens on the view picker and takes focus. */
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

	updateTab(id: string, patch: Partial<Omit<SidePanelTab, 'id'>>) {
		this.#setTabs((tab) => (tab.id === id ? { ...tab, ...patch } : tab));
		this.#emit();
	}

	/** Runs on every keystroke, so it only re-renders when the tab gains or loses its draft. */
	setFileDraft(id: string, draft: FileDraft | undefined) {
		const tab = this.tabs.find((candidate) => candidate.id === id);

		if (!tab) return;
		this.#setTabs((candidate) => (candidate === tab ? { ...tab, draft } : candidate));

		if (!tab.draft !== !draft) this.#emit();
	}

	/** Closing a pane's last tab closes the pane; closing the last pane resets the panel. */
	closeTab(id: string) {
		const pane = this.#paneOf(id);

		if (!pane) return;

		const panes = this.panes;
		const index = pane.tabs.findIndex((tab) => tab.id === id);
		const tabs = pane.tabs.filter((tab) => tab.id !== id);

		if (tabs.length === 0 && panes.length === 1) {
			this.panel = { ...DEFAULT_SIDE_PANEL_SNAPSHOT };
		} else if (tabs.length === 0) {
			const rest = panes.filter((candidate) => candidate !== pane);
			const paneIndex = panes.indexOf(pane);

			const activePaneId =
				this.panel.activePaneId === pane.id
					? rest[Math.min(paneIndex, rest.length - 1)]!.id
					: this.panel.activePaneId;

			this.#setPanes((candidate) => (candidate === pane ? null : candidate));
			this.panel = { ...this.panel, activePaneId };
		} else {
			const activeTabId =
				pane.activeTabId === id ? tabs[Math.min(index, tabs.length - 1)]!.id : pane.activeTabId;

			this.#setPanes((candidate) =>
				candidate === pane ? { ...pane, tabs, activeTabId } : candidate
			);
		}

		this.#emit();
	}

	/** Focuses a tab already showing the artifact, reuses an empty tab, or opens a new one. */
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

	/** Shows the tab already editing the file, reuses an empty tab, or opens a new one. */
	openFile(file: WorkspaceFileTarget) {
		const existing = this.tabs.find(
			(tab) =>
				tab.view === 'file' &&
				tab.file?.workspacePath === file.workspacePath &&
				tab.file.path === file.path
		);

		if (existing && this.panel.open && this.activeTab === existing) return;
		this.#show(existing, { view: 'file', file });
	}

	/** Shows `directory` in the active files tab, the first files tab, an empty tab, or a new one. */
	openDirectory(directory: WorkspaceFileTarget) {
		this.#show(
			[this.activeTab, ...this.tabs].find((tab) => tab.view === 'files'),
			{ view: 'files', directory }
		);
	}

	/** Keeps open file tabs pointing at a renamed file or folder. */
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

	/** Callers never remove the last pane, so the layout stays non-empty. */
	#setPanes(map: (pane: SidePanelPane) => SidePanelLayout | null) {
		this.panel = { ...this.panel, layout: mapPanes(this.panel.layout, map)! };
	}

	#setTabs(map: (tab: SidePanelTab) => SidePanelTab) {
		this.#setPanes((pane) => ({ ...pane, tabs: pane.tabs.map(map) }));
	}

	#focus(pane: SidePanelPane, patch: Partial<Pick<SidePanelPane, 'tabs' | 'activeTabId'>>) {
		this.#setPanes((candidate) => (candidate === pane ? { ...pane, ...patch } : candidate));
		this.panel = { ...this.panel, activePaneId: pane.id };
	}

	/** Puts `content` in `existing`, else the active tab when it's empty, else a new tab in the active pane, and focuses it. */
	#show(existing: SidePanelTab | undefined, content: Partial<Omit<SidePanelTab, 'id'>>) {
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
		this.panel = { ...this.panel, open: true };
		this.#emit();
	}

	#emit() {
		this.#version += 1;

		for (const listener of this.#listeners) listener();
	}

	async #watchLocal(
		localApi: ArtifactLocalApi | null,
		workspacePath: string,
		request: ArtifactsWatchRequest,
		state: {
			ac: AbortController;
			generation: number;
			scopeKey: string;
			setLocal: (state: ArtifactWatchState | null) => void;
		}
	) {
		if (!localApi || !workspacePath) return;

		while (!state.ac.signal.aborted) {
			await localApi
				.watchArtifacts(request, {
					signal: state.ac.signal,
					onEvent: (event) => {
						if (
							!isCurrentArtifactsWatch({
								aborted: state.ac.signal.aborted,
								generation: state.generation,
								currentGeneration: this.#watchGeneration,
								eventScopeKey: state.scopeKey,
								currentScopeKey: this.#watchScope
							})
						) {
							return;
						}

						state.setLocal(applyArtifactsWatchEvent(event));
					}
				})
				.catch(() => undefined);

			if (
				!state.ac.signal.aborted &&
				state.generation === this.#watchGeneration &&
				this.#watchScope === state.scopeKey
			) {
				state.setLocal(null);
			}

			if (!state.ac.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1_000));
		}
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

export function createConvexArtifactClient(client: ConvexArtifactClient): ArtifactClient {
	return {
		query: (query, args) => client.query(query, args),
		onUpdate: (query, args, onUpdate, onError) => {
			const watch = client.watchQuery(query, args);

			const report = () => {
				try {
					const revision = watch.localQueryResult();

					if (revision !== undefined) onUpdate(revision);
				} catch (error) {
					onError(error instanceof Error ? error : new Error(String(error)));
				}
			};

			report();

			return watch.onUpdate(report);
		}
	};
}
