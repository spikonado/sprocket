import { untrack } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import type { Id } from '$convex/_generated/dataModel';
import {
	EMPTY_ARTIFACT_WATCH_STATE,
	applyArtifactsWatchEvent,
	artifactEntryFromLocal,
	artifactRevisionFromLocal,
	artifactWatchScopeKey,
	artifactsWatchRequest,
	isCurrentArtifactsWatch,
	mergeArtifactSources,
	nextArtifactRevisionWatch,
	type ArtifactRevision,
	type ArtifactWatchState
} from '$lib/chat/artifacts';
import { watchCloudArtifacts, type CloudArtifactScope } from '$lib/chat/cloud-artifacts';
import { DEFAULT_SIDE_PANEL_SNAPSHOT, type SidePanelSnapshot } from '$lib/chat/side-panel';
import type { DesktopApi } from '$lib/types/sprocket';

type ArtifactClient = Parameters<typeof watchCloudArtifacts>[0];
type Scope = {
	userId: string;
	repositoryKey: string;
	workspacePath: string;
	threadId: Id<'threadRecords'> | null;
};

export class ArtifactPanel {
	watchState = $state<ArtifactWatchState>({ ...EMPTY_ARTIFACT_WATCH_STATE });
	panel = $state<SidePanelSnapshot>({ ...DEFAULT_SIDE_PANEL_SNAPSHOT });
	fullscreenKey = $state<string | null>(null);

	#watchGeneration = 0;
	#hasSnapshot = $state(false);
	#watchScope = $state<string | null>(null);
	#snapshots = new SvelteMap<string, SidePanelSnapshot>();
	#panelScopeKey: string | null = null;
	#revisionWatch: { scopeKey: string; revisions: Map<string, ArtifactRevision> } | null = null;
	#browserWatch: { threadId: Id<'threadRecords'>; runId: Id<'runs'> | null } | null = null;

	get artifacts() {
		return this.watchState.artifacts.map(artifactEntryFromLocal);
	}

	get fullscreenArtifact() {
		return this.artifacts.find((artifact) => artifact.key === this.fullscreenKey) ?? null;
	}

	selectScope(scope: Scope | null) {
		const scopeKey = scope ? artifactWatchScopeKey(scope) : null;
		if (scopeKey === this.#panelScopeKey) return;
		if (this.#panelScopeKey) this.#snapshots.set(this.#panelScopeKey, this.panel);
		this.#panelScopeKey = scopeKey;
		this.fullscreenKey = null;
		this.panel = {
			...((scopeKey && this.#snapshots.get(scopeKey)) || DEFAULT_SIDE_PANEL_SNAPSHOT)
		};
	}

	watch(args: {
		localApi: DesktopApi | null;
		artifactClient: ArtifactClient;
		cloudReady: boolean;
		scope: Scope | null;
	}) {
		const generation = ++this.#watchGeneration;
		this.#hasSnapshot = false;
		this.watchState = { ...EMPTY_ARTIFACT_WATCH_STATE };
		this.#revisionWatch = null;
		if (!args.scope) {
			this.#watchScope = null;
			return;
		}

		const scopeKey = artifactWatchScopeKey(args.scope);
		this.#watchScope = scopeKey;
		const ac = new AbortController();
		const request = artifactsWatchRequest(args.scope);
		let cloud: ArtifactWatchState = { artifacts: [], stale: true, error: null };
		let local: ArtifactWatchState | null = null;
		const publish = () => {
			if (ac.signal.aborted || generation !== this.#watchGeneration) return;
			this.watchState = mergeArtifactSources(cloud, local);
			if (!this.watchState.stale || this.watchState.artifacts.length > 0) this.#hasSnapshot = true;
		};
		const cloudScope: CloudArtifactScope = {
			userId: args.scope.userId,
			repositoryKey: args.scope.repositoryKey
		};
		if (args.scope.threadId) cloudScope.threadId = args.scope.threadId;
		const stopCloud = args.cloudReady
			? watchCloudArtifacts(args.artifactClient, cloudScope, (snapshot) => {
					cloud = snapshot;
					publish();
				})
			: () => {};
		void this.#watchLocal(args.localApi, args.scope.workspacePath, request, {
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

	trackArtifactChanges() {
		const scopeKey = this.#watchScope;
		if (!scopeKey || !this.#hasSnapshot) {
			if (this.#revisionWatch && this.#revisionWatch.scopeKey !== scopeKey) {
				this.#revisionWatch = null;
			}
			return;
		}
		if (this.#revisionWatch && this.#revisionWatch.scopeKey !== scopeKey) {
			this.#revisionWatch = null;
		}
		const current = this.watchState.artifacts.map(artifactRevisionFromLocal);
		const previous = this.#revisionWatch?.revisions ?? null;
		const { revisions, changedId } = nextArtifactRevisionWatch(previous, current);
		this.#revisionWatch = { scopeKey, revisions };
		if (!changedId) return;

		const prior = untrack(() => this.panel);
		this.panel = {
			...prior,
			open: true,
			tab: prior.open ? prior.tab : 'artifacts',
			selectedKey: !prior.open || prior.selectedKey === null ? changedId : prior.selectedKey
		};
	}

	trackBrowserActivity(args: {
		threadId: Id<'threadRecords'> | null;
		lastUsedRunId: Id<'runs'> | null | undefined;
		activeRunId: Id<'runs'> | null;
		loaded: boolean;
	}) {
		if (!args.threadId) {
			this.#browserWatch = null;
			return;
		}
		if (this.#browserWatch && this.#browserWatch.threadId !== args.threadId) {
			this.#browserWatch = null;
		}
		if (!args.loaded) return;

		const sessionRunId = args.lastUsedRunId ?? null;
		const previous = this.#browserWatch;
		this.#browserWatch = { threadId: args.threadId, runId: sessionRunId };
		if (sessionRunId === null || sessionRunId !== args.activeRunId) return;
		if (previous?.runId === sessionRunId) return;

		const prior = untrack(() => this.panel);
		if (prior.open && prior.tab === 'live') return;
		this.panel = { ...prior, open: true, tab: 'live' };
	}

	reset() {
		this.#snapshots.clear();
		this.#panelScopeKey = null;
		this.#watchScope = null;
		this.#revisionWatch = null;
		this.#browserWatch = null;
		this.panel = { ...DEFAULT_SIDE_PANEL_SNAPSHOT };
		this.fullscreenKey = null;
	}

	update(patch: Partial<SidePanelSnapshot>) {
		this.panel = { ...this.panel, ...patch };
	}

	async #watchLocal(
		localApi: DesktopApi | null,
		workspacePath: string,
		request: ReturnType<typeof artifactsWatchRequest>,
		state: {
			ac: AbortController;
			generation: number;
			scopeKey: string;
			setLocal: (state: ArtifactWatchState | null) => void;
		}
	) {
		while (localApi && workspacePath && !state.ac.signal.aborted) {
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
