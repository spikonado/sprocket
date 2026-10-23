import type { Text } from '@codemirror/state';
import type { WorkspaceFileTarget } from '$lib/types/sprocket';

export type SidePanelView = 'artifacts' | 'files' | 'browser' | 'file';

/** Unsaved edits to `base`, the content read at `version`. */
export type FileDraft = { doc: Text; base: Text; version: string };

export type SidePanelTab = {
	id: string;
	/** `null` shows the view picker. */
	view: SidePanelView | null;
	/** Selected artifact, for the artifacts view. */
	selectedKey: string | null;
	/** Open workspace file, for the file view. */
	file?: WorkspaceFileTarget;
	/** Folder to show, for the files view; `workspacePath` overrides the thread or project root. */
	directory?: WorkspaceFileTarget;
	/** Unsaved edits in the file view; they live here so they outlive the editor. */
	draft?: FileDraft;
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
	layout: SidePanelLayout;
	activePaneId: string;
};

export const DEFAULT_SIDE_PANEL_SNAPSHOT: SidePanelSnapshot = {
	open: false,
	expanded: false,
	layout: {
		type: 'pane',
		id: 'pane-0',
		tabs: [{ id: 'tab-0', view: null, selectedKey: null }],
		activeTabId: 'tab-0'
	},
	activePaneId: 'pane-0'
};

export type SidePanelPane = {
	type: 'pane';
	id: string;
	tabs: SidePanelTab[];
	activeTabId: string;
};

/** `row` puts `first` left of `second`; `column` puts it above. */
export type SplitDirection = 'row' | 'column';

export type SidePanelSplit = {
	type: 'split';
	id: string;
	direction: SplitDirection;
	/** Share of the split taken by `first`. */
	ratio: number;
	first: SidePanelLayout;
	second: SidePanelLayout;
};

export type SidePanelLayout = SidePanelPane | SidePanelSplit;

/** Smallest pane, in pixels, that still fits its header and content along each split direction. */
export const MIN_PANE_SIZE = { row: 240, column: 160 } as const satisfies Record<
	SplitDirection,
	number
>;

/** Pixels `node` needs along `direction` so every pane inside it, at its current ratios, keeps `MIN_PANE_SIZE`. */
export function minLayoutSize(node: SidePanelLayout, direction: SplitDirection): number {
	if (node.type === 'pane') return MIN_PANE_SIZE[direction];

	const first = minLayoutSize(node.first, direction);
	const second = minLayoutSize(node.second, direction);

	return node.direction === direction
		? Math.max(first / node.ratio, second / (1 - node.ratio))
		: Math.max(first, second);
}

/** Fractions of the whole panel. */
export type LayoutRect = { left: number; top: number; width: number; height: number };

type PlacedLayout = {
	panes: { pane: SidePanelPane; rect: LayoutRect }[];
	splits: { split: SidePanelSplit; rect: LayoutRect }[];
};

export function panesOf(node: SidePanelLayout): SidePanelPane[] {
	return node.type === 'pane' ? [node] : [...panesOf(node.first), ...panesOf(node.second)];
}

/** Replaces every pane with `map`'s result; a split whose side maps to null becomes its other side. */
export function mapPanes(
	node: SidePanelLayout,
	map: (pane: SidePanelPane) => SidePanelLayout | null
): SidePanelLayout | null {
	if (node.type === 'pane') return map(node);

	const first = mapPanes(node.first, map);
	const second = mapPanes(node.second, map);

	if (!first || !second) return first ?? second;

	return { ...node, first, second };
}

export function mapSplit(
	node: SidePanelLayout,
	id: string,
	map: (split: SidePanelSplit) => SidePanelLayout
): SidePanelLayout {
	if (node.type === 'pane') return node;

	if (node.id === id) return map(node);

	return { ...node, first: mapSplit(node.first, id, map), second: mapSplit(node.second, id, map) };
}

export function layoutRects(
	node: SidePanelLayout,
	rect: LayoutRect = { left: 0, top: 0, width: 1, height: 1 }
): PlacedLayout {
	if (node.type === 'pane') return { panes: [{ pane: node, rect }], splits: [] };

	const row = node.direction === 'row';
	const firstSize = (row ? rect.width : rect.height) * node.ratio;
	const firstRect = row ? { ...rect, width: firstSize } : { ...rect, height: firstSize };

	const secondRect = row
		? { ...rect, left: rect.left + firstSize, width: rect.width - firstSize }
		: { ...rect, top: rect.top + firstSize, height: rect.height - firstSize };

	const first = layoutRects(node.first, firstRect);
	const second = layoutRects(node.second, secondRect);

	return {
		panes: [...first.panes, ...second.panes],
		splits: [{ split: node, rect }, ...first.splits, ...second.splits]
	};
}

/** The pane in the panel's top-right corner, which holds the panel-wide buttons. */
export function topRightPane(node: SidePanelLayout): SidePanelPane {
	if (node.type === 'pane') return node;

	return topRightPane(node.direction === 'row' ? node.second : node.first);
}
