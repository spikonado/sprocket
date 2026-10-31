import { describe, expect, it } from 'vitest';
import { groupAssistantTimeline, type AssistantTimelineTool } from './assistant-timeline';
import { mergeWorkToolCounts, workSummary, workToolCounts } from './work-summary';

describe('work summaries', () => {
	it('counts pending and failed calls once and excludes polls from the header', () => {
		const pending: AssistantTimelineTool = {
			type: 'tool',
			callId: 'pending',
			name: 'exec_cmd',
			input: {}
		};

		const failed: AssistantTimelineTool = {
			type: 'tool',
			callId: 'failed',
			name: 'exec_cmd',
			input: {},
			output: { error: 'failed' }
		};

		const blocks = groupAssistantTimeline([
			pending,
			failed,
			pending,
			{ type: 'tool', callId: 'skill', name: 'read_skill', input: {} },
			{ type: 'tool', callId: 'poll', name: 'poll_cmd', input: {} }
		]).filter((block) => block.type !== 'text');

		expect(workSummary(workToolCounts(blocks))).toBe('Read 1 skill; Ran 2 commands');
	});

	it('merges stored and live calls in a fixed order', () => {
		expect(
			workSummary(
				mergeWorkToolCounts({ apply_patch: 2, exec_command: 3 }, { exec_cmd: 7, read_skill: 1 })
			)
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
