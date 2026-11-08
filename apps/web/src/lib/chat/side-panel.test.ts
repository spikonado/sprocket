import { expect, it } from 'vitest';
import { MIN_PANE_SIZE, minLayoutSize, type SidePanelLayout } from './side-panel';

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

	expect(minLayoutSize(layout, 'row')).toBe(MIN_PANE_SIZE.row / ((1 - 0.5) * (1 - 0.75)));
	expect(minLayoutSize(layout, 'column')).toBe(MIN_PANE_SIZE.column / (1 - 0.5));
});
