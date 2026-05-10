import { describe, expect, it } from 'vitest';
import {
	buildPersistedToolLogs,
	ensureAssistantToolPartsFromJobs,
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

	it('backfills work-log parts from executor jobs when no streamed tool parts were persisted', () => {
		const parts: AssistantPart[] = [{ type: 'text', id: 'text-1', text: 'Done.' }];

		const hydratedParts = ensureAssistantToolPartsFromJobs(parts, [
			{
				id: 'job-1',
				kind: 'read_file',
				payload: { path: 'AGENTS.md' },
				status: 'completed',
				result: { path: 'AGENTS.md', contents: 'instructions' }
			}
		]);
		const logs = buildPersistedToolLogs(hydratedParts);

		expect(logs).toHaveLength(1);
		expect(logs[0]).toEqual({
			callId: 'executor-job:job-1',
			name: 'read_file',
			input: { path: 'AGENTS.md' },
			output: { path: 'AGENTS.md', contents: 'instructions' }
		});
	});

	it('does not duplicate executor jobs when tool parts are already persisted', () => {
		const parts: AssistantPart[] = [
			{
				type: 'tool-call',
				callId: 'call-1',
				name: 'read_file',
				input: { path: 'AGENTS.md' }
			}
		];

		const hydratedParts = ensureAssistantToolPartsFromJobs(parts, [
			{
				id: 'job-1',
				kind: 'read_file',
				payload: { path: 'AGENTS.md' },
				status: 'completed',
				result: { path: 'AGENTS.md', contents: 'instructions' }
			}
		]);

		expect(hydratedParts).toEqual(parts);
	});
});
