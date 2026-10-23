import { expect, it } from 'vitest';
import { minLayoutSize, type SidePanelLayout } from './side-panel';

const pane = (id: string): SidePanelLayout => ({ type: 'pane', id, tabs: [], activeTabId: '' });

it('sizes a layout so every nested pane keeps its minimum at the current ratios', () => {
	const layout: SidePanelLayout = {
		type: 'split',
		id: 'outer',
		direction: 'row',
		ratio: 0.5,
		first: pane('a'),
		second: {
			type: 'split',
			id: 'inner',
			direction: 'column',
			ratio: 0.5,
			first: pane('b'),
			second: {
				type: 'split',
				id: 'deep',
				direction: 'row',
				ratio: 0.75,
				first: pane('c'),
				second: pane('d')
			}
		}
	};

	// Pane d gets a quarter of a half, so the panel needs 8 × 240px.
	expect(minLayoutSize(layout, 'row')).toBe(1920);
	expect(minLayoutSize(layout, 'column')).toBe(320);
});
