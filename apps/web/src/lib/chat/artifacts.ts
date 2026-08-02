import type { ArtifactType } from '$convex/lib/validators';

export type ArtifactEntry = {
	key: string;
	title: string;
	artifactType: ArtifactType;
	content: string;
};

/** Revision used to detect creates/updates for auto-opening the panel. */
export type ArtifactRevision = {
	id: string;
	/** Change signal: content writes always bump this. */
	currentVersion: number;
	/** Rank key among concurrent changes; not part of equality. */
	updatedAt: number;
};

/**
 * Diffs the latest artifact revisions against a prior snapshot.
 * When `previous` is null (first observation for a thread), only seeds — never reports a change.
 */
export function nextArtifactRevisionWatch(
	previous: ReadonlyMap<string, ArtifactRevision> | null,
	current: readonly ArtifactRevision[]
): { revisions: Map<string, ArtifactRevision>; changedId: string | null } {
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
			(!prior || prior.currentVersion !== artifact.currentVersion) &&
			(!latestChange || artifact.updatedAt >= latestChange.updatedAt)
		) {
			latestChange = artifact;
		}
	}

	return { revisions, changedId: latestChange?.id ?? null };
}
