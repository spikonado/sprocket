import type { ArtifactType } from '$convex/lib/validators';
import type {
	ArtifactScope,
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
	scope: ArtifactScope;
	localError?: string;
};

export type ArtifactWatchScope = {
	userId: string;
	repositoryKey: string;
	workspacePath: string;
	threadId?: string | null;
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

export function artifactWatchScopeKey(scope: ArtifactWatchScope): string {
	return [scope.userId, scope.repositoryKey, scope.workspacePath, scope.threadId ?? ''].join('\0');
}

export function artifactsWatchRequest(scope: ArtifactWatchScope): ArtifactsWatchRequest {
	const request: ArtifactsWatchRequest = {
		userId: scope.userId,
		repositoryKey: scope.repositoryKey,
		workspacePath: scope.workspacePath
	};
	if (scope.threadId) {
		request.threadId = scope.threadId;
	}
	return request;
}

export function artifactEntryFromLocal(artifact: LocalArtifact): ArtifactEntry {
	return {
		key: artifact._id,
		title: artifact.title,
		artifactType: artifact.type,
		content: artifact.content,
		localPath: artifact.localPath,
		scope: artifact.scope,
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
		if (artifact.localPath || !artifacts.has(artifact._id)) artifacts.set(artifact._id, artifact);
	}
	return {
		artifacts: [...artifacts.values()],
		stale: cloud.stale && (!local || local.stale),
		error: local?.error ?? cloud.error
	};
}
