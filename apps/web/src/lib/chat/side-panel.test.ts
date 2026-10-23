import { expect, it } from 'vitest';
import { paneSpan, type SidePanelLayout } from './side-panel';

const pane = (id: string): SidePanelLayout => ({ type: 'pane', id, tabs: [], activeTabId: '' });

it('counts the most panes lined up along each direction', () => {
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
				ratio: 0.5,
				first: pane('c'),
				second: pane('d')
			}
		}
	};

	expect(paneSpan(layout, 'row')).toBe(3);
	expect(paneSpan(layout, 'column')).toBe(2);
});
