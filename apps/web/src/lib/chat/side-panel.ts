export type SidePanelView = 'artifacts' | 'browser';

/** Stored panel state, restored when revisiting a project workspace. */
export type SidePanelSnapshot = {
	open: boolean;
	/** When true, the panel covers the full Sprocket workspace UI. */
	expanded: boolean;
	/** `null` shows the view picker. */
	view: SidePanelView | null;
	/** Selected artifact, for the artifacts view. */
	selectedKey: string | null;
};

export const DEFAULT_SIDE_PANEL_SNAPSHOT: SidePanelSnapshot = {
	open: false,
	expanded: false,
	view: null,
	selectedKey: null
};
