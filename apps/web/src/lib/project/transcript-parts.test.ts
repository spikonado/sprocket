import { describe, expect, it } from 'vitest';
import type { Id } from '$convex/_generated/dataModel';
import type { AssistantPart } from '$convex/lib/assistantParts';
import type { LocalTranscriptPart, ThreadMessage } from '$lib/types/sprocket';
import { assembleTranscriptParts } from './transcript-parts';

// SAFETY: These tests only compare opaque fixture IDs.
const threadId = 'thread' as Id<'threadRecords'>;

function promptPart(number: number, runId = `run-${number}`): LocalTranscriptPart {
	return {
		number,
		kind: 'prompt',
		message: {
			_id: `prompt:${runId}`,
			threadId,
			// SAFETY: These tests only compare opaque fixture IDs.
			runId: runId as Id<'runs'>,
			userId: 'user',
			type: 'prompt',
			text: String(number),
			parts: [],
			attachments: [],
			runStatus: 'completed',
			runStartedAt: 0,
			sourceNumbers: [number],
			streamIds: [],
			detailsLoaded: true
		}
	};
}

function responseMessage(
	number: number,
	runId: string,
	overrides: Partial<ThreadMessage> = {}
): ThreadMessage {
	return {
		_id: `response:${runId}`,
		threadId,
		// SAFETY: These tests only compare opaque fixture IDs.
		runId: runId as Id<'runs'>,
		userId: 'user',
		type: 'response',
		text: '',
		parts: [],
		attachments: [],
		runStatus: 'completed',
		runStartedAt: 0,
		sourceNumbers: [number],
		streamIds: [],
		detailsLoaded: false,
		...overrides
	};
}

function completionPart(
	number: number,
	runId: string,
	overrides: Partial<ThreadMessage> = {}
): LocalTranscriptPart {
	const text = overrides.text ?? `t${number}`;
	return {
		number,
		kind: 'completion',
		message: responseMessage(number, runId, {
			text,
			parts: overrides.parts ?? [{ type: 'text', id: `t-${number}`, text }],
			streamIds: overrides.streamIds ?? [`stream-${number}`],
			...overrides
		})
	};
}

function toolPart(
	number: number,
	runId: string,
	parts: AssistantPart[],
	detailsLoaded = false
): LocalTranscriptPart {
	return {
		number,
		kind: 'tool',
		message: responseMessage(number, runId, { parts, detailsLoaded })
	};
}

function call(callId: string, startedAt?: number): Extract<AssistantPart, { type: 'tool-call' }> {
	return {
		type: 'tool-call',
		callId,
		name: 'exec_command',
		input: null,
		startedAt
	};
}

function result(callId: string, completedAt?: number): AssistantPart {
	return {
		type: 'tool-result',
		callId,
		name: 'exec_command',
		output: { status: 'completed' },
		completedAt
	};
}

describe('assembleTranscriptParts', () => {
	it('groups prompts and responses by run in numeric order', () => {
		const messages = assembleTranscriptParts([
			completionPart(3, 'run-2', { text: 'later' }),
			promptPart(0, 'run-1'),
			promptPart(2, 'run-2'),
			completionPart(1, 'run-1', { text: 'first' })
		]);
		expect(messages.map((message) => message._id)).toEqual([
			'prompt:run-1',
			'response:run-1',
			'prompt:run-2',
			'response:run-2'
		]);
		expect(messages.map((message) => message.text)).toEqual(['0', 'first', '2', 'later']);
	});

	it('joins disjoint completion pages for the same run without dropping either slice', () => {
		const messages = assembleTranscriptParts([
			completionPart(10, 'run-1', { text: 'tail' }),
			completionPart(11, 'run-1', { text: 'end' }),
			completionPart(0, 'run-1', { text: 'head' }),
			completionPart(1, 'run-1', { text: 'mid' })
		]);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.text).toBe('headmidtailend');
		expect(messages[0]?.sourceNumbers).toEqual([0, 1, 10, 11]);
		expect(messages[0]?.streamIds).toEqual(['stream-0', 'stream-1', 'stream-10', 'stream-11']);
		expect(
			messages[0]?.parts.map((part) => (part.type === 'text' ? part.text : part.type))
		).toEqual(['head', 'mid', 'tail', 'end']);
	});

	it('reattaches terminal tools persisted before the completion that ordered their calls', () => {
		const messages = assembleTranscriptParts([
			completionPart(0, 'run-1', { text: 'previous turn' }),
			toolPart(1, 'run-1', [call('b', 1_100)]),
			toolPart(2, 'run-1', [call('a', 1_200)]),
			toolPart(3, 'run-1', [call('a'), result('a', 1_800)]),
			completionPart(4, 'run-1', {
				text: 'checking',
				streamIds: ['stream-4'],
				parts: [
					{ type: 'reasoning', id: 'r', text: '' },
					{ type: 'text', id: 't', text: 'checking' },
					call('a'),
					call('b')
				]
			}),
			toolPart(5, 'run-1', [call('b'), result('b', 2_400)]),
			completionPart(6, 'run-1', { text: 'answer', streamIds: ['stream-6'] })
		]);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.parts.map((part) => part.type)).toEqual([
			'text',
			'reasoning',
			'text',
			'tool-call',
			'tool-result',
			'tool-call',
			'tool-result',
			'text'
		]);
		expect(messages[0]?.parts[3]).toMatchObject({
			type: 'tool-call',
			callId: 'a',
			startedAt: 1_200
		});
		expect(messages[0]?.parts[4]).toMatchObject({
			type: 'tool-result',
			callId: 'a',
			completedAt: 1_800
		});
		expect(messages[0]?.parts[5]).toMatchObject({
			type: 'tool-call',
			callId: 'b',
			startedAt: 1_100
		});
		expect(messages[0]?.parts[6]).toMatchObject({
			type: 'tool-result',
			callId: 'b',
			completedAt: 2_400
		});
		expect(messages[0]?.text).toBe('previous turncheckinganswer');
		expect(messages[0]?.streamIds).toEqual(['stream-0', 'stream-4', 'stream-6']);
		expect(messages[0]?.sourceNumbers).toEqual([0, 1, 2, 3, 4, 5, 6]);
	});

	it('keeps a completion start time over an earlier placeholder', () => {
		const messages = assembleTranscriptParts([
			toolPart(1, 'run-1', [call('c1', 500)]),
			completionPart(2, 'run-1', {
				text: '',
				parts: [{ ...call('c1'), startedAt: 700, input: {} }],
				streamIds: ['s']
			})
		]);
		expect(messages[0]?.parts[0]).toMatchObject({
			type: 'tool-call',
			callId: 'c1',
			startedAt: 700
		});
	});

	it('does not duplicate a terminal result that already followed its call', () => {
		const messages = assembleTranscriptParts([
			toolPart(1, 'run-1', [call('c1'), result('c1', 5_000)]),
			toolPart(2, 'run-1', [call('c1'), result('c1', 9_000)])
		]);
		expect(messages[0]?.parts.map((part) => part.type)).toEqual(['tool-call', 'tool-result']);
		expect(messages[0]?.parts[1]).toMatchObject({ completedAt: 5_000 });
	});

	it('marks a response fully loaded only when every contributing part is detailed', () => {
		const light = completionPart(1, 'run-1', {
			parts: [{ type: 'reasoning', id: 'r', text: '' }],
			text: '',
			detailsLoaded: false
		});
		const detailed = completionPart(1, 'run-1', {
			parts: [{ type: 'reasoning', id: 'r', text: 'plan' }],
			text: '',
			detailsLoaded: true
		});
		const later = completionPart(2, 'run-1', { text: 'done', detailsLoaded: false });
		const mixed = assembleTranscriptParts([detailed, later]);
		expect(mixed[0]?.detailsLoaded).toBe(false);
		expect(mixed[0]?.parts[0]).toMatchObject({ type: 'reasoning', text: 'plan' });
		expect(assembleTranscriptParts([light, later])[0]?.detailsLoaded).toBe(false);
		expect(
			assembleTranscriptParts([
				detailed,
				completionPart(2, 'run-1', { text: 'done', detailsLoaded: true })
			])[0]?.detailsLoaded
		).toBe(true);
	});

	it('skips null projections and last-wins on duplicate numbers', () => {
		const messages = assembleTranscriptParts([
			{ number: 1, kind: 'completion', message: null },
			completionPart(2, 'run-1', { text: 'old' }),
			completionPart(2, 'run-1', { text: 'new' }),
			promptPart(0)
		]);
		expect(messages.map((message) => message.text)).toEqual(['0', 'new']);
		expect(messages[1]?.sourceNumbers).toEqual([2]);
	});
});
