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

/** Revision used to detect creates/updates for auto-opening the panel. */
export type ArtifactRevision = {
	id: string;
	/** Cloud revision when present; local file writes may land before this bumps. */
	currentVersion: number;
	/** Rank key among concurrent changes; not part of equality. */
	updatedAt: number;
	/** Local file body; compared so edits are visible before cloud ack. */
	content: string;
	/** A retargeted path counts as a change even when content is identical. */
	localPath?: string;
};

/**
 * Diffs the latest artifact revisions against a prior snapshot.
 * When `previous` is null (first observation for a scope), only seeds; never reports a change.
 */
export type ArtifactRevisionWatch = {
	revisions: Map<string, ArtifactRevision>;
	changedId: string | null;
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

export function artifactRevisionFromLocal(artifact: LocalArtifact): ArtifactRevision {
	return {
		id: artifact._id,
		currentVersion: artifact.revision,
		updatedAt: artifact.updatedAt,
		content: artifact.content,
		localPath: artifact.localPath
	};
}

function artifactIdentityChanged(prior: ArtifactRevision, artifact: ArtifactRevision) {
	return prior.content !== artifact.content || prior.localPath !== artifact.localPath;
}

export function nextArtifactRevisionWatch(
	previous: ReadonlyMap<string, ArtifactRevision> | null,
	current: readonly ArtifactRevision[]
): ArtifactRevisionWatch {
	const revisions = new Map<string, ArtifactRevision>(
		current.map((artifact) => [artifact.id, artifact])
	);
	if (previous === null) {
		return { revisions, changedId: null };
	}

	let latestChange: ArtifactRevision | null = null;
	for (const artifact of current) {
		const prior = previous.get(artifact.id);
		if (
			(!prior || artifactIdentityChanged(prior, artifact)) &&
			(!latestChange || artifact.updatedAt >= latestChange.updatedAt)
		) {
			latestChange = artifact;
		}
	}

	return { revisions, changedId: latestChange?.id ?? null };
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
