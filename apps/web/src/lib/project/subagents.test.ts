import { describe, expect, it } from 'vitest';
import { subagentStatusRows } from './subagents';

describe('subagentStatusRows', () => {
	it('shows only working descendants while work is active', () => {
		expect(subagentStatusRows(9, 2, true)).toEqual([
			{ status: 'running', label: '2 subagents · Working' }
		]);
	});

	it('omits counts while descendants are only queued or awaiting an answer', () => {
		expect(subagentStatusRows(3, 0, true)).toEqual([]);
	});

	it('shows the total without a status after all descendant work ends', () => {
		expect(subagentStatusRows(5, 0, false)).toEqual([
			{ status: 'completed', label: '5 subagents' }
		]);
	});

	it('uses singular copy and omits empty trees', () => {
		expect(subagentStatusRows(1, 1, true)).toEqual([
			{ status: 'running', label: '1 subagent · Working' }
		]);
		expect(subagentStatusRows(1, 0, false)).toEqual([{ status: 'completed', label: '1 subagent' }]);
		expect(subagentStatusRows(0, 0, false)).toEqual([]);
	});
});
