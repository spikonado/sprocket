import { describe, expect, it } from 'vitest';
import {
	ensureAssistantToolPartsFromJobs,
	joinAssistantTextParts,
	resolveAssistantMessageText,
	type AssistantPart
} from '$convex/lib/assistantParts';

describe('assistant tool parts', () => {
	it('joins text from distinct model turns with a blank line', () => {
		expect(
			joinAssistantTextParts([
				{ type: 'text', id: 'text-1', text: 'First turn.', turnId: 'turn-1' },
				{ type: 'text', id: 'text-2', text: ' Continued.', turnId: 'turn-1' },
				{ type: 'text', id: 'text-3', text: 'Second turn.', turnId: 'turn-2' }
			])
		).toBe('First turn. Continued.\n\nSecond turn.');
	});

	it('preserves final text when reconciliation removes the only provisional tool call', () => {
		const reconciledParts = ensureAssistantToolPartsFromJobs(
			[
				{
					type: 'tool-call',
					callId: 'provisional-call',
					name: 'exec_command',
					input: {},
					turnId: 'provisional-turn'
				}
			],
			[]
		);

		expect(reconciledParts).toEqual([]);
		expect(
			resolveAssistantMessageText(joinAssistantTextParts(reconciledParts), 'Final answer')
		).toBe('Final answer');
	});

	it('backfills assistant timeline parts from executor jobs when no streamed tool parts were persisted', () => {
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
		expect(hydratedParts).toEqual([
			parts[0],
			{
				type: 'tool-call',
				callId: 'executor-job:job-1',
				name: 'exec_command',
				input: { cmd: 'cat AGENTS.md' }
			},
			{
				type: 'tool-result',
				callId: 'executor-job:job-1',
				name: 'exec_command',
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
			}
		]);
	});

	it('adds executor results to streamed calls without duplicating the call', () => {
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

		expect(hydratedParts).toEqual([
			parts[0],
			{
				type: 'tool-result',
				callId: 'call-1',
				name: 'exec_command',
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
			}
		]);
	});

	it('correlates executor jobs by call id and removes unmatched provisional calls', () => {
		const hydrated = ensureAssistantToolPartsFromJobs(
			[
				{ type: 'tool-call', callId: 'rejected', name: 'exec_command', input: {} },
				{ type: 'tool-call', callId: 'executed', name: 'wrong_name', input: {} }
			],
			[
				{
					id: 'job-1',
					callId: 'executed',
					kind: 'exec_command',
					payload: { cmd: 'pwd' },
					status: 'failed',
					error: 'failed'
				}
			]
		);

		expect(hydrated).toEqual([
			{ type: 'tool-call', callId: 'executed', name: 'exec_command', input: { cmd: 'pwd' } },
			{
				type: 'tool-result',
				callId: 'executed',
				name: 'exec_command',
				output: { error: 'failed', status: 'failed' }
			}
		]);
	});

	it('persists a cancelled discriminant on tool-result error output', () => {
		const hydrated = ensureAssistantToolPartsFromJobs(
			[{ type: 'tool-call', callId: 'call-1', name: 'exec_command', input: { cmd: 'sleep' } }],
			[
				{
					id: 'job-1',
					callId: 'call-1',
					kind: 'exec_command',
					payload: { cmd: 'sleep' },
					status: 'cancelled',
					error: 'stopped by user'
				}
			]
		);

		expect(hydrated).toEqual([
			{ type: 'tool-call', callId: 'call-1', name: 'exec_command', input: { cmd: 'sleep' } },
			{
				type: 'tool-result',
				callId: 'call-1',
				name: 'exec_command',
				output: { error: 'stopped by user', status: 'cancelled' }
			}
		]);
	});

	it('places results beside their calls when job order differs from part order', () => {
		const hydrated = ensureAssistantToolPartsFromJobs(
			[
				{ type: 'tool-call', callId: 'call-1', name: 'exec_command', input: { cmd: 'one' } },
				{ type: 'text', id: 'text-1', text: 'between' },
				{ type: 'tool-call', callId: 'call-2', name: 'exec_command', input: { cmd: 'two' } }
			],
			[
				{
					id: 'job-2',
					callId: 'call-2',
					kind: 'exec_command',
					payload: { cmd: 'two' },
					status: 'completed',
					result: 'two'
				},
				{
					id: 'job-1',
					callId: 'call-1',
					kind: 'exec_command',
					payload: { cmd: 'one' },
					status: 'completed',
					result: 'one'
				}
			]
		);

		expect(
			hydrated.map((part) => `${part.type}:${'callId' in part ? part.callId : part.id}`)
		).toEqual([
			'tool-call:call-1',
			'tool-result:call-1',
			'text:text-1',
			'tool-call:call-2',
			'tool-result:call-2'
		]);
	});

	it('removes every persisted part from a turn whose tool calls are all unmatched', () => {
		const hydrated = ensureAssistantToolPartsFromJobs(
			[
				{ type: 'text', id: 'valid-text', text: 'Keep me', turnId: 'valid-turn' },
				{
					type: 'tool-call',
					callId: 'valid-call',
					name: 'exec_command',
					input: {},
					turnId: 'valid-turn'
				},
				{ type: 'tool-result', callId: 'valid-call', output: 'done' },
				{ type: 'reasoning', id: 'abandoned-reasoning', text: 'Discard', turnId: 'bad-turn' },
				{ type: 'text', id: 'abandoned-text', text: 'Discard', turnId: 'bad-turn' },
				{
					type: 'tool-call',
					callId: 'abandoned-call',
					name: 'exec_command',
					input: {},
					turnId: 'bad-turn'
				}
			],
			[]
		);

		expect(hydrated.map((part) => part.type)).toEqual(['text', 'tool-call', 'tool-result']);
		expect(hydrated).not.toContainEqual(expect.objectContaining({ turnId: 'bad-turn' }));
	});

	it('removes only unmatched calls from a turn that also contains a matched call', () => {
		const hydrated = ensureAssistantToolPartsFromJobs(
			[
				{ type: 'reasoning', id: 'reasoning', text: 'Keep reasoning', turnId: 'mixed-turn' },
				{ type: 'text', id: 'text', text: 'Keep prose', turnId: 'mixed-turn' },
				{
					type: 'tool-call',
					callId: 'matched-call',
					name: 'exec_command',
					input: { cmd: 'pwd' },
					turnId: 'mixed-turn'
				},
				{ type: 'tool-result', callId: 'matched-call', output: 'done' },
				{
					type: 'tool-call',
					callId: 'unmatched-call',
					name: 'exec_command',
					input: { cmd: 'discard' },
					turnId: 'mixed-turn'
				}
			],
			[]
		);

		expect(hydrated).toEqual([
			{ type: 'reasoning', id: 'reasoning', text: 'Keep reasoning', turnId: 'mixed-turn' },
			{ type: 'text', id: 'text', text: 'Keep prose', turnId: 'mixed-turn' },
			{
				type: 'tool-call',
				callId: 'matched-call',
				name: 'exec_command',
				input: { cmd: 'pwd' },
				turnId: 'mixed-turn'
			},
			{ type: 'tool-result', callId: 'matched-call', output: 'done' }
		]);
	});

	it('does not mutate caller-owned parts while reconciling jobs', () => {
		const input = { cmd: 'old', nested: { value: 1 } };
		const parts: AssistantPart[] = [
			{ type: 'tool-call', callId: 'call-1', name: 'wrong_name', input }
		];
		const original = structuredClone(parts);

		const hydrated = ensureAssistantToolPartsFromJobs(parts, [
			{
				id: 'job-1',
				callId: 'call-1',
				kind: 'exec_command',
				payload: { cmd: 'new' },
				status: 'completed',
				result: 'done'
			}
		]);

		expect(parts).toEqual(original);
		expect(hydrated[0]).toMatchObject({ name: 'exec_command', input: { cmd: 'new' } });
		expect(hydrated[0]).not.toBe(parts[0]);
	});
});
