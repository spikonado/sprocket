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
	renamedPath,
	type FileDraft,
	type SidePanelSnapshot,
	type SidePanelTab
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
	#nextTabId = 1;
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

	get activeTab() {
		return this.panel.tabs.find((tab) => tab.id === this.panel.activeTabId) ?? this.panel.tabs[0]!;
	}

	get hasFileDrafts() {
		const hasDraft = (panel: SidePanelSnapshot) => panel.tabs.some((tab) => tab.draft);

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

	newTab() {
		const empty = this.panel.tabs.find((tab) => tab.view === null);

		if (empty) {
			this.activateTab(empty.id);

			return;
		}

		const tab = this.#createTab();
		this.panel = { ...this.panel, tabs: [...this.panel.tabs, tab], activeTabId: tab.id };
		this.#emit();
	}

	activateTab(id: string) {
		if (this.panel.activeTabId === id) return;
		this.panel = { ...this.panel, activeTabId: id };
		this.#emit();
	}

	updateTab(id: string, patch: Partial<Omit<SidePanelTab, 'id'>>) {
		this.panel = {
			...this.panel,
			tabs: this.panel.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab))
		};
		this.#emit();
	}

	/** Runs on every keystroke, so it only re-renders when the tab gains or loses its draft. */
	setFileDraft(id: string, draft: FileDraft | undefined) {
		const tab = this.panel.tabs.find((candidate) => candidate.id === id);

		if (!tab) return;
		this.panel = {
			...this.panel,
			tabs: this.panel.tabs.map((candidate) => (candidate === tab ? { ...tab, draft } : candidate))
		};

		if (!tab.draft !== !draft) this.#emit();
	}

	closeTab(id: string) {
		const index = this.panel.tabs.findIndex((tab) => tab.id === id);

		if (index === -1) return;

		const tabs = this.panel.tabs.filter((tab) => tab.id !== id);

		if (tabs.length === 0) {
			this.panel = { ...DEFAULT_SIDE_PANEL_SNAPSHOT };
		} else {
			const activeTabId =
				this.panel.activeTabId === id
					? tabs[Math.min(index, tabs.length - 1)]!.id
					: this.panel.activeTabId;

			this.panel = { ...this.panel, tabs, activeTabId };
		}

		this.#emit();
	}

	/** Focuses a tab already showing the artifact, reuses an empty tab, or opens a new one. */
	openArtifact(key: string) {
		const existing = this.panel.tabs.find(
			(tab) => tab.view === 'artifacts' && tab.selectedKey === key
		);

		const active = this.activeTab;
		let tabs = this.panel.tabs;
		let activeTabId: string;

		if (existing) {
			activeTabId = existing.id;
		} else if (active.view === null) {
			activeTabId = active.id;
			tabs = tabs.map((tab) =>
				tab.id === active.id ? { ...tab, view: 'artifacts', selectedKey: key } : tab
			);
		} else {
			const tab = { ...this.#createTab(), view: 'artifacts' as const, selectedKey: key };
			activeTabId = tab.id;
			tabs = [...tabs, tab];
		}

		this.panel = { ...this.panel, open: true, tabs, activeTabId };
		this.#emit();
	}

	setFullscreenKey(key: string | null) {
		if (this.fullscreenKey === key) return;
		this.fullscreenKey = key;
		this.#emit();
	}

	/** Shows the tab already editing the file, or opens a new one. */
	openFile(file: WorkspaceFileTarget) {
		const existing = this.panel.tabs.find(
			(tab) =>
				tab.view === 'file' &&
				tab.file?.workspacePath === file.workspacePath &&
				tab.file.path === file.path
		);

		if (existing) {
			if (this.panel.open && this.panel.activeTabId === existing.id) return;
			this.panel = { ...this.panel, open: true, activeTabId: existing.id };
		} else {
			const tab: SidePanelTab = { ...this.#createTab(), view: 'file', file };
			this.panel = {
				...this.panel,
				open: true,
				tabs: [...this.panel.tabs, tab],
				activeTabId: tab.id
			};
		}

		this.#emit();
	}

	/** Shows `directory` in the active files tab, the first files tab, an empty tab, or a new one. */
	openDirectory(directory: WorkspaceFileTarget) {
		const active = this.activeTab;

		const target =
			[active, ...this.panel.tabs].find((tab) => tab.view === 'files') ??
			(active.view === null ? active : this.#createTab());

		const tab: SidePanelTab = { ...target, view: 'files', directory };
		const exists = this.panel.tabs.some((candidate) => candidate.id === tab.id);

		this.panel = {
			...this.panel,
			open: true,
			tabs: exists
				? this.panel.tabs.map((candidate) => (candidate.id === tab.id ? tab : candidate))
				: [...this.panel.tabs, tab],
			activeTabId: tab.id
		};
		this.#emit();
	}

	/** Keeps open file tabs pointing at a renamed file or folder. */
	renameFile(workspacePath: string, from: string, to: string) {
		let changed = false;

		const tabs = this.panel.tabs.map((tab) => {
			if (tab.file?.workspacePath !== workspacePath) return tab;
			const path = renamedPath(tab.file.path, from, to);

			if (path === null) return tab;
			changed = true;

			return { ...tab, file: { workspacePath, path } };
		});

		if (!changed) return;
		this.panel = { ...this.panel, tabs };
		this.#emit();
	}

	closeFile(workspacePath: string, path: string) {
		for (const tab of this.panel.tabs) {
			if (tab.file?.workspacePath === workspacePath && isSameOrInside(tab.file.path, path)) {
				this.closeTab(tab.id);
			}
		}
	}

	#createTab(): SidePanelTab {
		return { id: `tab-${this.#nextTabId++}`, view: null, selectedKey: null };
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
