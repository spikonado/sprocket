import { describe, expect, it } from 'vitest';
import { subagentStatusRows } from './subagents';

const emptyCounts = {
	queued: 0,
	running: 0,
	completed: 0,
	failed: 0,
	cancelled: 0
};

describe('subagentStatusRows', () => {
	it('counts running subagents as working and every other known status as completed', () => {
		expect(
			subagentStatusRows(9, {
				queued: 1,
				running: 2,
				completed: 3,
				failed: 1,
				cancelled: 2
			})
		).toEqual([
			{ status: 'running', label: '2 subagents · Working' },
			{ status: 'completed', label: '6 subagents · Completed' }
		]);
	});

	it('omits starting counts from the inbox rows', () => {
		expect(
			subagentStatusRows(3, {
				...emptyCounts,
				queued: 3
			})
		).toEqual([]);
	});

	it('folds uncounted descendants into completed instead of a separate status', () => {
		expect(
			subagentStatusRows(5, {
				...emptyCounts,
				running: 1,
				completed: 2
			})
		).toEqual([
			{ status: 'running', label: '1 subagent · Working' },
			{ status: 'completed', label: '4 subagents · Completed' }
		]);
	});

	it('uses singular copy for a single completed subagent', () => {
		expect(
			subagentStatusRows(1, {
				...emptyCounts,
				completed: 1
			})
		).toEqual([{ status: 'completed', label: '1 subagent · Completed' }]);
	});
});
