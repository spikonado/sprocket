import type { Text } from '@codemirror/state';
import type { WorkspaceFileTarget } from '$lib/types/sprocket';

export type SidePanelView = 'transcript' | 'artifacts' | 'files' | 'browser' | 'file';

export type SidePanelContentView = Exclude<SidePanelView, 'transcript'>;

export type FileDraft = { doc: Text; base: Text; version: string };

export type SidePanelTab = {
	id: string;
	view: SidePanelView | null;
	selectedKey: string | null;
	file?: WorkspaceFileTarget;
	directory?: WorkspaceFileTarget;
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

export function renamedPath(path: string, from: string, to: string) {
	return isSameOrInside(path, from) ? `${to}${path.slice(from.length)}` : null;
}

export type SidePanelSnapshot = {
	layout: SidePanelLayout;
	activePaneId: string;
};

export const DEFAULT_SIDE_PANEL_SNAPSHOT: SidePanelSnapshot = {
	layout: {
		type: 'pane',
		id: 'pane-0',
		tabs: [{ id: 'tab-0', view: 'transcript', selectedKey: null }],
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

export type SplitDirection = 'row' | 'column';

export type SidePanelSplit = {
	type: 'split';
	id: string;
	direction: SplitDirection;
	ratio: number;
	first: SidePanelLayout;
	second: SidePanelLayout;
};

export type SidePanelLayout = SidePanelPane | SidePanelSplit;

export const MIN_PANE_SIZE = { row: 240, column: 160 } as const satisfies Record<
	SplitDirection,
	number
>;

export function minLayoutSize(node: SidePanelLayout, direction: SplitDirection): number {
	if (node.type === 'pane') return MIN_PANE_SIZE[direction];

	const first = minLayoutSize(node.first, direction);
	const second = minLayoutSize(node.second, direction);

	return node.direction === direction
		? Math.max(first / node.ratio, second / (1 - node.ratio))
		: Math.max(first, second);
}

export type FractionalRect = { left: number; top: number; width: number; height: number };

type PlacedLayout = {
	panes: { pane: SidePanelPane; rect: FractionalRect }[];
	splits: { split: SidePanelSplit; rect: FractionalRect }[];
};

export function panesOf(node: SidePanelLayout): SidePanelPane[] {
	return node.type === 'pane' ? [node] : [...panesOf(node.first), ...panesOf(node.second)];
}

export function mapPanes(
	node: SidePanelLayout,
	map: (pane: SidePanelPane) => SidePanelLayout
): SidePanelLayout {
	if (node.type === 'pane') return map(node);

	return { ...node, first: mapPanes(node.first, map), second: mapPanes(node.second, map) };
}

export function removePane(node: SidePanelLayout, id: string): SidePanelLayout {
	if (node.type === 'pane') return node;

	if (node.first.type === 'pane' && node.first.id === id) return node.second;

	if (node.second.type === 'pane' && node.second.id === id) return node.first;

	return { ...node, first: removePane(node.first, id), second: removePane(node.second, id) };
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
	rect: FractionalRect = { left: 0, top: 0, width: 1, height: 1 }
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
