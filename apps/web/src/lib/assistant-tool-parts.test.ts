import { describe, expect, it } from 'vitest';
import {
	buildPersistedToolLogs,
	upsertAssistantToolCallPart,
	upsertAssistantToolResultPart,
	type AssistantPart
} from '$lib/assistant-tool-parts';

describe('assistant tool parts', () => {
	it('keeps parallel tool calls distinct when stream ids collide', () => {
		const parts: AssistantPart[] = [];
		const callIndex = new Map<string, number>();
		const resultIndex = new Map<string, number>();

		const sharedInput = { path: 'GEMINI.md' };
		upsertAssistantToolCallPart(parts, callIndex, 'read_file', 'call-1', sharedInput);
		sharedInput.path = 'CLAUDE.md';
		upsertAssistantToolCallPart(parts, callIndex, 'read_file', 'call-2', sharedInput);
		sharedInput.path = 'AGENTS.md';
		upsertAssistantToolCallPart(parts, callIndex, 'read_file', 'call-3', sharedInput);

		const sharedOutput = { path: 'GEMINI.md', contents: 'gemini' };
		upsertAssistantToolResultPart(parts, resultIndex, 'call-1', {
			name: 'read_file',
			output: sharedOutput
		});
		sharedOutput.path = 'CLAUDE.md';
		sharedOutput.contents = 'claude';
		upsertAssistantToolResultPart(parts, resultIndex, 'call-2', {
			name: 'read_file',
			output: sharedOutput
		});
		sharedOutput.path = 'AGENTS.md';
		sharedOutput.contents = 'agents';
		upsertAssistantToolResultPart(parts, resultIndex, 'call-3', {
			name: 'read_file',
			output: sharedOutput
		});

		const logs = buildPersistedToolLogs(parts);

		expect(logs).toHaveLength(3);
		expect(logs.map((log) => (log.input as { path: string }).path)).toEqual([
			'GEMINI.md',
			'CLAUDE.md',
			'AGENTS.md'
		]);
		expect(logs.map((log) => (log.output as { contents: string }).contents)).toEqual([
			'gemini',
			'claude',
			'agents'
		]);
	});
});
