import type { WorkspaceFileTarget } from '$lib/types/sprocket';

export type SidePanelView = 'artifacts' | 'files' | 'browser' | 'file';

export type SidePanelTab = {
	id: string;
	/** `null` shows the view picker. */
	view: SidePanelView | null;
	/** Selected artifact, for the artifacts view. */
	selectedKey: string | null;
	/** Open workspace file, for the file view. */
	file?: WorkspaceFileTarget;
};

export function trimSlash(path: string) {
	return path.endsWith('/') ? path.slice(0, -1) : path;
}

export function leafName(path: string) {
	const trimmed = trimSlash(path);

	return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

export function isSameOrInside(path: string, entry: string) {
	return path === entry || path.startsWith(`${entry}/`);
}

/** Maps `path` through a rename of `from` to `to`; returns null when unaffected. */
export function renamedPath(path: string, from: string, to: string) {
	return isSameOrInside(path, from) ? `${to}${path.slice(from.length)}` : null;
}

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
