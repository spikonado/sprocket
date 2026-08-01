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
	/** When true, the panel covers the full Sprocket workspace UI. */
	expanded: boolean;
	selectedKey: string | null;
};
