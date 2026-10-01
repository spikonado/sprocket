import { describe, expect, it } from 'vitest';
import {
	joinAssistantTextParts,
	matchAssistantToolCallsToJobs,
	type AssistantToolCallPart,
	type MatchableExecutorToolJob
} from '@convex/lib/assistantParts';

describe('assistant text parts', () => {
	it('separates text from distinct model turns', () => {
		expect(
			joinAssistantTextParts([
				{ type: 'text', id: 'text-1', text: 'First turn.', turnId: 'turn-1' },
				{ type: 'text', id: 'text-2', text: ' Continued.', turnId: 'turn-1' },
				{ type: 'text', id: 'text-3', text: 'Second turn.', turnId: 'turn-2' }
			])
		).toBe('First turn. Continued.\n\nSecond turn.');
	});
});

describe('matchAssistantToolCallsToJobs', () => {
	it('matches explicit callIds, disambiguates reversed payloads, and leaves ambiguity unmatched', () => {
		const calls: AssistantToolCallPart[] = [
			{ type: 'tool-call', callId: 'call-explicit', name: 'write_stdin', input: {} },
			{ type: 'tool-call', callId: 'call-one', name: 'exec_command', input: { cmd: 'one' } },
			{ type: 'tool-call', callId: 'call-two', name: 'exec_command', input: { cmd: 'two' } },
			{
				type: 'tool-call',
				callId: 'call-ambiguous-a',
				name: 'apply_patch',
				input: { patch: 'same' }
			},
			{
				type: 'tool-call',
				callId: 'call-ambiguous-b',
				name: 'apply_patch',
				input: { patch: 'same' }
			}
		];

		const jobs: MatchableExecutorToolJob[] = [
			{ id: 'job-explicit', kind: 'write_stdin', callId: 'call-explicit', payload: {} },
			{ id: 'job-two', kind: 'exec_command', payload: { cmd: 'two' } },
			{ id: 'job-one', kind: 'exec_command', payload: { cmd: 'one' } },
			{ id: 'job-ambiguous', kind: 'apply_patch', payload: { patch: 'same' } }
		];

		const matched = matchAssistantToolCallsToJobs(calls, jobs);

		expect(matched).toEqual(
			new Map([
				['job-explicit', 'call-explicit'],
				['job-two', 'call-two'],
				['job-one', 'call-one']
			])
		);
	});
});
