export type SidePanelView = 'artifacts' | 'files' | 'browser';

export type SidePanelTab = {
	id: string;
	/** `null` shows the view picker. */
	view: SidePanelView | null;
	/** Selected artifact, for the artifacts view. */
	selectedKey: string | null;
};

/** Stored panel state, restored when revisiting a project workspace. */
export type SidePanelSnapshot = {
	open: boolean;
	/** When true, the panel covers the full Sprocket workspace UI. */
	expanded: boolean;
	tabs: SidePanelTab[];
	activeTabId: string;
};

export const DEFAULT_SIDE_PANEL_SNAPSHOT: SidePanelSnapshot = {
	open: false,
	expanded: false,
	tabs: [{ id: 'tab-0', view: null, selectedKey: null }],
	activeTabId: 'tab-0'
};
