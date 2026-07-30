import type { ArtifactType } from '$convex/lib/validators';

export type ArtifactEntry = {
	key: string;
	title: string;
	artifactType: ArtifactType;
	content: string;
};

/** Stored panel state, restored when revisiting a thread. */
export type ArtifactPanelSnapshot = {
	open: boolean;
	selectedKey: string | null;
};
