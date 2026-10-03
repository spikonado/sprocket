import { describe, expect, it } from 'vitest';
import type { AssistantTimelineTool } from '$lib/chat/assistant-timeline';
import { commandSnapshotLabel, fullToolSummary, toolItemSummary } from '$lib/chat/tool-summaries';

describe('command tool summaries', () => {
	it.each([
		{ workdir: undefined, expected: 'bun run build' },
		{ workdir: '.', expected: 'bun run build' },
		{ workdir: ' \t ', expected: 'bun run build' },
		{ workdir: '/repo', expected: 'bun run build (cwd /repo)' },
		{ workdir: 'apps/web', expected: 'bun run build (cwd apps/web)' }
	])('summarizes exec_cmd with workdir $workdir', ({ workdir, expected }) => {
		const tool: AssistantTimelineTool = {
			type: 'tool',
			callId: 'exec',
			name: 'exec_cmd',
			input: { cmd: 'bun run build' }
		};

		if (workdir !== undefined) tool.input = { cmd: 'bun run build', workdir };

		expect(toolItemSummary(tool, new Map())).toBe(expected);
	});

	it.each([
		{ action: 'write', chars: 'yes\n', expected: 'Write to Session 7' },
		{ action: 'terminate', expected: 'Terminate Session 7' }
	])('describes control action $action before a command label is available', (input) => {
		const tool: AssistantTimelineTool = {
			type: 'tool',
			callId: 'control',
			name: 'control_cmd',
			input: { sessionId: '7', action: input.action, chars: input.chars ?? '' }
		};

		expect(toolItemSummary(tool, new Map())).toBe(input.expected);
		expect(toolItemSummary(tool, new Map([['7', 'bun run build']]))).toBe('bun run build');
	});

	describe.each(['poll_cmd', 'poll_command', 'write_stdin'])('%s', (name) => {
		it('falls back to the session ID until the command label is available', () => {
			const tool: AssistantTimelineTool = {
				type: 'tool',
				callId: 'monitor',
				name,
				input: { sessionId: '7' }
			};

			expect(toolItemSummary(tool, new Map())).toBe('Session 7');
			expect(toolItemSummary(tool, new Map([['7', 'bun run build']]))).toBe('bun run build');
		});

		it('uses a generic session label when no session ID is available', () => {
			const tool: AssistantTimelineTool = {
				type: 'tool',
				callId: 'monitor',
				name,
				input: {}
			};

			expect(toolItemSummary(tool, new Map())).toBe('Command session');
		});
	});

	it.each(['control_cmd', 'poll_cmd', 'control_command', 'poll_command', 'write_stdin'])(
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
