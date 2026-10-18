export type SidePanelTab = 'launcher' | 'artifacts' | 'browser';

/** Stored panel state, restored when revisiting a project workspace. */
export type SidePanelSnapshot = {
	open: boolean;
	/** When true, the panel covers the full Sprocket workspace UI. */
	expanded: boolean;
	tab: SidePanelTab;
	/** Selected artifact, for the artifacts tab. */
	selectedKey: string | null;
};

export const DEFAULT_SIDE_PANEL_SNAPSHOT: SidePanelSnapshot = {
	open: false,
	expanded: false,
	tab: 'launcher',
	selectedKey: null
};
