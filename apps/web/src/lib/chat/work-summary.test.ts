import { describe, expect, it } from 'vitest';
import { workSummary } from './work-summary';

describe('work summaries', () => {
	it('formats projected counts and legacy tool names in a fixed order', () => {
		expect(
			workSummary({ apply_patch: 2, exec_command: 3, exec_cmd: 7, read_skill: 1, poll_cmd: 5 })
		).toBe('Read 1 skill; Ran 10 commands; Applied 2 patches');
	});

	it('does not count command control calls as commands launched', () => {
		expect(workSummary({ exec_cmd: 1, poll_cmd: 5, control_cmd: 2 })).toBe(
			'Ran 1 command; Controlled 2 commands'
		);
	});

	it('falls back to polls, or no summary without tool calls', () => {
		expect(workSummary({})).toBeUndefined();
		expect(workSummary({ poll_subagent: 2, poll_question: 1 })).toBe('Polled tool calls');
	});

	it('includes uncategorized calls without exposing tool identifiers', () => {
		expect(workSummary({ future_tool: 2 })).toBe('Used 2 tools');
	});
});
