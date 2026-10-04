import type { ArtifactType } from '@convex/lib/validators';
import type {
	ArtifactsWatchEvent,
	ArtifactsWatchRequest,
	LocalArtifact
} from '$lib/types/sprocket';

export type ArtifactEntry = {
	key: string;
	title: string;
	artifactType: ArtifactType;
	content: string;
	localPath?: string;
	localError?: string;
};

export type ArtifactWatchState = {
	artifacts: LocalArtifact[];
	stale: boolean;
	error: string | null;
};

export const EMPTY_ARTIFACT_WATCH_STATE: ArtifactWatchState = {
	artifacts: [],
	stale: false,
	error: null
};

export function artifactWatchScopeKey(scope: ArtifactsWatchRequest): string {
	return [scope.userId, scope.repositoryKey, scope.workspacePath].join('\0');
}

export function artifactEntryFromLocal(artifact: LocalArtifact): ArtifactEntry {
	return {
		key: artifact._id,
		title: artifact.title,
		artifactType: artifact.type,
		content: artifact.content,
		localPath: artifact.localPath,
		localError: artifact.localError
	};
}

export function isCurrentArtifactsWatch(args: {
	aborted: boolean;
	generation: number;
	currentGeneration: number;
	eventScopeKey: string;
	currentScopeKey: string | null;
}): boolean {
	return (
		!args.aborted &&
		args.generation === args.currentGeneration &&
		args.currentScopeKey === args.eventScopeKey
	);
}

export function applyArtifactsWatchEvent(event: ArtifactsWatchEvent): ArtifactWatchState {
	return {
		artifacts: event.artifacts,
		stale: event.stale,
		error: event.error ?? null
	};
}

export function mergeArtifactSources(
	cloud: ArtifactWatchState,
	local: ArtifactWatchState | null
): ArtifactWatchState {
	const artifacts = new Map(cloud.artifacts.map((artifact) => [artifact._id, artifact]));

	for (const artifact of local?.artifacts ?? []) {
		// A fresh cloud registry owns membership; late local snapshots must not
		// bring back deleted artifacts while their watcher catches up.
		if (!cloud.stale && !artifacts.has(artifact._id)) continue;

		if (artifact.localPath || !artifacts.has(artifact._id)) artifacts.set(artifact._id, artifact);
	}

	return {
		artifacts: [...artifacts.values()],
		stale: cloud.stale && (!local || local.stale),
		error: local?.error ?? cloud.error
	};
}
