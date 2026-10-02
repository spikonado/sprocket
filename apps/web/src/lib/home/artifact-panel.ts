import { useState } from 'react';
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
import { DEFAULT_SIDE_PANEL_SNAPSHOT, type SidePanelSnapshot } from '$lib/chat/side-panel';
import { useStore, type Store } from '$lib/store';
import type { ArtifactsWatchRequest, DesktopApi } from '$lib/types/sprocket';

type ArtifactClient = Parameters<typeof watchCloudArtifacts>[0];

type ArtifactLocalApi = Pick<DesktopApi, 'watchArtifacts'>;

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

	update(patch: Partial<SidePanelSnapshot>) {
		this.panel = { ...this.panel, ...patch };
		this.#emit();
	}

	setFullscreenKey(key: string | null) {
		if (this.fullscreenKey === key) return;
		this.fullscreenKey = key;
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

export function useArtifactPanel() {
	const [panel] = useState(() => new ArtifactPanel());
	useStore(panel);

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
