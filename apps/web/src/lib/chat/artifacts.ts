import { isJsonObject, type JsonObject } from '$convex/lib/json';
import type { ArtifactType } from '$convex/lib/validators';
import { parseArtifactType } from '$lib/chat/artifact-preview';
import type { ExecutorJob } from '$lib/types/sprocket';

export type ArtifactEntry = {
	key: string;
	title: string;
	artifactType: ArtifactType;
	content: string;
	enqueuedAt: number;
};

/** Builds the artifact list for a thread from its executor jobs. */
export function collectArtifacts(actions: ExecutorJob[]): ArtifactEntry[] {
	const entries = new Map<string, ArtifactEntry>();
	for (const job of actions) {
		if (job.kind !== 'create_artifact' && job.kind !== 'update_artifact') continue;
		if (!isJsonObject(job.payload)) continue;
		const payload: JsonObject = job.payload;
		if (typeof payload.content !== 'string') continue;

		const result = isJsonObject(job.result) ? (job.result as JsonObject) : undefined;
		const title =
			typeof payload.title === 'string'
				? payload.title
				: typeof result?.title === 'string'
					? result.title
					: 'Updated Artifact';
		const key =
			typeof result?.artifactId === 'string'
				? result.artifactId
				: job.kind === 'create_artifact' && typeof payload.title === 'string'
					? `title:${payload.title}`
					: job._id;
		// A create whose result arrives later upgrades the earlier title-keyed entry.
		const provisionalKey = `title:${title}`;
		if (key !== provisionalKey && entries.has(provisionalKey)) {
			entries.delete(provisionalKey);
		}

		entries.set(key, {
			key,
			title,
			artifactType: parseArtifactType(payload.contentType ?? result?.contentType),
			content: payload.content,
			enqueuedAt: job.enqueuedAt
		});
	}
	return [...entries.values()];
}
