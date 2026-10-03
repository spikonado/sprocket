import { describe, expect, it } from 'vitest';
import type { AssistantTimelineTool } from '$lib/chat/assistant-timeline';
import { commandSnapshotLabel, fullToolSummary, toolItemSummary } from '$lib/chat/tool-summaries';

describe('command tool summaries', () => {
	it.each([
		{ action: 'write', chars: 'yes\n', expected: 'Write to Session 7' },
		{ action: 'terminate', expected: 'Terminate Session 7' }
	])('describes control action $action before a command label is available', (input) => {
		const tool: AssistantTimelineTool = {
			type: 'tool',
			callId: 'control',
			name: 'control_command',
			input: { sessionId: '7', action: input.action, chars: input.chars ?? '' }
		};

		expect(toolItemSummary(tool, new Map())).toBe(input.expected);
		expect(toolItemSummary(tool, new Map([['7', 'bun run build']]))).toBe('bun run build');
	});

	it.each(['control_command', 'poll_command', 'write_stdin'])(
		'keeps a returned %s snapshot distinct from an in-flight tool call',
		(name) => {
			const tool: AssistantTimelineTool = {
				type: 'tool',
				callId: 'snapshot',
				name,
				input: { sessionId: '7' },
				output: { command: 'bun run build', workdir: '/repo', running: true, output: '' }
			};

			expect(commandSnapshotLabel(tool)).toBe('Still running when this call returned');
			expect(fullToolSummary(tool, true, new Map())).toBe('bun run build');
		}
	);
});
