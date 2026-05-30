import { describe, expect, it } from 'vitest';
import {
	buildPersistedToolLogs,
	ensureAssistantToolPartsFromJobs,
	upsertAssistantToolCallPart,
	upsertAssistantToolResultPart,
	type AssistantPart
} from '$convex/lib/assistantParts';

describe('assistant tool parts', () => {
	it('keeps parallel tool calls distinct when stream ids collide', () => {
		const parts: AssistantPart[] = [];
		const callIndex = new Map<string, number>();
		const resultIndex = new Map<string, number>();

		const sharedInput = { cmd: 'cat GEMINI.md' };
		upsertAssistantToolCallPart(parts, callIndex, 'exec_command', 'call-1', sharedInput);
		sharedInput.cmd = 'cat CLAUDE.md';
		upsertAssistantToolCallPart(parts, callIndex, 'exec_command', 'call-2', sharedInput);
		sharedInput.cmd = 'cat AGENTS.md';
		upsertAssistantToolCallPart(parts, callIndex, 'exec_command', 'call-3', sharedInput);

		const sharedOutput = { output: 'gemini' };
		upsertAssistantToolResultPart(parts, resultIndex, 'call-1', {
			name: 'exec_command',
			output: sharedOutput
		});
		sharedOutput.output = 'claude';
		upsertAssistantToolResultPart(parts, resultIndex, 'call-2', {
			name: 'exec_command',
			output: sharedOutput
		});
		sharedOutput.output = 'agents';
		upsertAssistantToolResultPart(parts, resultIndex, 'call-3', {
			name: 'exec_command',
			output: sharedOutput
		});

		const logs = buildPersistedToolLogs(parts);

		expect(logs).toHaveLength(3);
		expect(logs.map((log) => (log.input as { cmd: string }).cmd)).toEqual([
			'cat GEMINI.md',
			'cat CLAUDE.md',
			'cat AGENTS.md'
		]);
		expect(logs.map((log) => (log.output as { output: string }).output)).toEqual([
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
				kind: 'exec_command',
				payload: { cmd: 'cat AGENTS.md' },
				status: 'completed',
				result: {
					command: 'cat AGENTS.md',
					cwd: '.',
					success: true,
					timedOut: false,
					stdout: 'instructions',
					stderr: '',
					output: 'instructions',
					truncated: false,
					exitCode: 0
				}
			}
		]);
		const logs = buildPersistedToolLogs(hydratedParts);

		expect(logs).toHaveLength(1);
		expect(logs[0]).toEqual({
			callId: 'executor-job:job-1',
			name: 'exec_command',
			input: { cmd: 'cat AGENTS.md' },
			output: {
				command: 'cat AGENTS.md',
				cwd: '.',
				success: true,
				timedOut: false,
				stdout: 'instructions',
				stderr: '',
				output: 'instructions',
				truncated: false,
				exitCode: 0
			}
		});
	});

	it('does not duplicate executor jobs when tool parts are already persisted', () => {
		const parts: AssistantPart[] = [
			{
				type: 'tool-call',
				callId: 'call-1',
				name: 'exec_command',
				input: { cmd: 'cat AGENTS.md' }
			}
		];

		const hydratedParts = ensureAssistantToolPartsFromJobs(parts, [
			{
				id: 'job-1',
				kind: 'exec_command',
				payload: { cmd: 'cat AGENTS.md' },
				status: 'completed',
				result: {
					command: 'cat AGENTS.md',
					cwd: '.',
					success: true,
					timedOut: false,
					stdout: 'instructions',
					stderr: '',
					output: 'instructions',
					truncated: false,
					exitCode: 0
				}
			}
		]);

		expect(hydratedParts).toEqual(parts);
	});
});
