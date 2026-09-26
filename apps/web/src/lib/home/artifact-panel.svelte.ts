import { SvelteMap } from 'svelte/reactivity';
import type { Id } from '$convex/_generated/dataModel';
import {
	EMPTY_ARTIFACT_WATCH_STATE,
	applyArtifactsWatchEvent,
	artifactEntryFromLocal,
	artifactWatchScopeKey,
	artifactsWatchRequest,
	isCurrentArtifactsWatch,
	mergeArtifactSources,
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
	#watchScope = $state<string | null>(null);
	#snapshots = new SvelteMap<string, SidePanelSnapshot>();
	#panelScopeKey: string | null = null;

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
		this.watchState = { ...EMPTY_ARTIFACT_WATCH_STATE };
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

	reset() {
		this.#snapshots.clear();
		this.#panelScopeKey = null;
		this.#watchScope = null;
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
