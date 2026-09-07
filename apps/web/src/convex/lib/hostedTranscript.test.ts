import { describe, expect, it } from 'vitest';
import type { Id } from '@convex/_generated/dataModel';
import {
	UNKNOWN_RUN_STARTED_AT,
	projectTranscriptMessages,
	type ProjectableTranscriptPart
} from '@convex/lib/hostedTranscript';
import { isJsonObject, type JsonValue } from '@convex/lib/json';
import type { TranscriptCompletionItem } from '@convex/lib/validators';

function fixtureId<Table extends 'threadRecords' | 'runs'>(value: string): Id<Table> {
	// SAFETY: projection fixtures only compare these ids as opaque strings.
	return value as Id<Table>;
}

const threadId = fixtureId<'threadRecords'>('thread-1');
const runId = (value: string) => fixtureId<'runs'>(value);

function prompt(number: number, text: string, run = 'run-1'): ProjectableTranscriptPart {
	return {
		number,
		kind: 'prompt',
		runId: runId(run),
		prompt: { text, imageUploads: [] }
	};
}

function completion(
	number: number,
	items: TranscriptCompletionItem[],
	run = 'run-1',
	streamId?: string
): ProjectableTranscriptPart {
	const part: ProjectableTranscriptPart = {
		number,
		kind: 'completion',
		runId: runId(run),
		completion: { items }
	};
	if (streamId) {
		part.completion = { streamId, items };
	}
	return part;
}

function tool(
	number: number,
	callId: string,
	status: 'started' | 'completed' | 'failed' | 'cancelled',
	createdAt?: number,
	output?: JsonValue,
	toolInvocationId?: string
): ProjectableTranscriptPart {
	const part: ProjectableTranscriptPart = {
		number,
		kind: 'tool',
		runId: runId('run-1'),
		createdAt,
		tool: {
			callId,
			name: 'exec_command',
			status
		}
	};
	if (output !== undefined && part.tool) part.tool.output = output;
	if (toolInvocationId && part.tool) part.tool.toolInvocationId = toolInvocationId;
	return part;
}

function project(parts: ProjectableTranscriptPart[], includeDetails = false) {
	return projectTranscriptMessages({
		userId: 'user',
		threadId,
		parts,
		includeDetails
	});
}

describe('projectTranscriptMessages', () => {
	it('groups completion and tool parts onto one response and preserves tool order', () => {
		const turn = completion(4, [
			{ type: 'reasoning', id: 'r', text: 'plan' },
			{ type: 'text', id: 't', text: 'checking' },
			{ type: 'tool-call', callId: 'a', name: 'exec_command', input: {} },
			{
				type: 'tool-call',
				callId: 'b',
				name: 'exec_command',
				input: {},
				startedAt: null,
				completedAt: null
			}
		]);
		for (const includeDetails of [false, true]) {
			const messages = project(
				[
					completion(0, [{ type: 'text', id: 'prev', text: 'previous turn' }]),
					tool(1, 'b', 'started', 1_100),
					tool(2, 'a', 'started', 1_200),
					tool(3, 'a', 'completed', 1_800, { status: 'completed' }),
					turn,
					tool(5, 'b', 'completed', 2_400, { status: 'completed' }),
					completion(6, [{ type: 'text', id: 'ans', text: 'answer' }])
				],
				includeDetails
			);
			expect(messages).toHaveLength(1);
			const parts = messages[0]?.parts ?? [];
			expect(parts.map((part) => part.type)).toEqual([
				'text',
				'reasoning',
				'text',
				'tool-call',
				'tool-result',
				'tool-call',
				'tool-result',
				'text'
			]);
			expect(parts[3]).toMatchObject({ type: 'tool-call', callId: 'a', startedAt: 1_200 });
			expect(parts[4]).toMatchObject({ type: 'tool-result', callId: 'a', completedAt: 1_800 });
			expect(parts[5]).toMatchObject({ type: 'tool-call', callId: 'b', startedAt: 1_100 });
			expect(parts[6]).toMatchObject({ type: 'tool-result', callId: 'b', completedAt: 2_400 });
			expect(parts[1]).toMatchObject({
				type: 'reasoning',
				text: includeDetails ? 'plan' : ''
			});
			expect(parts[1] && 'startedAt' in parts[1] ? parts[1].startedAt : undefined).toBeUndefined();
			expect(messages[0]?.text).toBe('previous turncheckinganswer');
			expect(messages[0]?.sourceNumbers).toEqual([0, 1, 2, 3, 4, 5, 6]);
		}
	});

	it('uses unknown run start instead of a sequence number', () => {
		const messages = project([prompt(7, 'hi')], true);
		expect(messages[0]?.runStartedAt).toBe(UNKNOWN_RUN_STARTED_AT);
		expect(messages[0]?.sourceNumbers).toEqual([7]);
		expect(messages[0]?._id).toBe('prompt:run-1');
	});

	it('does not invent a zero-duration start for a finished tool without a start event', () => {
		const messages = project([tool(1, 'c1', 'completed', 5_000)]);
		expect(messages[0]?.parts[0] && 'startedAt' in messages[0].parts[0]).toBe(false);
		expect(messages[0]?.parts[1]).toMatchObject({
			type: 'tool-result',
			completedAt: 5_000
		});
	});

	it('does not fabricate reasoning timing from part createdAt', () => {
		const part = completion(4, [{ type: 'reasoning', id: 'r', text: 'think' }]);
		part.createdAt = 9_000;
		const messages = project([part], true);
		expect(messages[0]?.parts[0] && 'startedAt' in messages[0].parts[0]).toBe(false);
		expect(messages[0]?.runStartedAt).toBe(UNKNOWN_RUN_STARTED_AT);
	});

	it('projects migrated null timing as missing', () => {
		const part = completion(4, [
			{
				type: 'text',
				id: 't',
				text: 'hi',
				startedAt: null,
				completedAt: null
			}
		]);
		for (const includeDetails of [false, true]) {
			const messages = project([part], includeDetails);
			const item = messages[0]?.parts[0];
			expect(item && 'startedAt' in item).toBe(false);
			expect(item && 'completedAt' in item).toBe(false);
		}
	});

	it('keeps a completion tool-call start over a placeholder start', () => {
		const messages = project(
			[
				tool(1, 'c1', 'started', 500),
				completion(2, [
					{
						type: 'tool-call',
						callId: 'c1',
						name: 'exec_command',
						input: {},
						startedAt: 700
					}
				])
			],
			true
		);
		expect(messages[0]?.parts[0]).toMatchObject({ startedAt: 700 });
	});

	it('keeps terminal state, sessions, and approvals in lightweight tool output', () => {
		const messages = project([
			completion(0, [
				{ type: 'text', id: 't', text: 'running' },
				{ type: 'reasoning', id: 'r', text: 'plan' },
				{
					type: 'tool-call',
					callId: 'c1',
					name: 'exec_command',
					input: { cmd: 'sleep 10' }
				}
			]),
			tool(
				1,
				'c1',
				'failed',
				2_000,
				{
					sessionId: 'session',
					running: true,
					command: 'sleep 10',
					status: 'failed',
					error: 'failure',
					output: 'large log',
					mandateId: 'mandate',
					approvalUrl: 'https://example.com/approve'
				},
				'inv-1'
			)
		]);
		const result = messages[0]?.parts.find((part) => part.type === 'tool-result');
		expect(result?.type).toBe('tool-result');
		if (result?.type !== 'tool-result' || !isJsonObject(result.output)) {
			throw new Error('expected tool result object');
		}
		expect(result.output.running).toBe(true);
		expect(result.output.sessionId).toBe('session');
		expect(result.output.error).toBe('failure');
		expect(result.output.approvalUrl).toBe('https://example.com/approve');
		expect(result.output.output).toBeUndefined();
		const call = messages[0]?.parts.find((part) => part.type === 'tool-call');
		expect(call).toMatchObject({ type: 'tool-call', input: null });
	});

	it('omits empty reasoning and strips provider metadata', () => {
		const messages = project(
			[
				completion(0, [
					{ type: 'reasoning', id: 'empty', text: '' },
					{ type: 'reasoning', id: 'blank', text: ' \n' },
					{
						type: 'reasoning',
						id: 'visible',
						text: 'plan',
						providerMetadata: { openai: { reasoningEncryptedContent: 'secret' } }
					},
					{ type: 'text', id: 'answer', text: 'done' }
				])
			],
			false
		);
		expect(messages[0]?.parts).toHaveLength(2);
		expect(messages[0]?.parts[0]).toMatchObject({ type: 'reasoning', id: 'visible', text: '' });
		expect(messages[0]?.parts[0] && 'providerMetadata' in messages[0].parts[0]).toBe(false);
		expect(messages[0]?.detailsLoaded).toBe(false);
	});

	it('keeps context-handoff history by projecting every numbered part in the page', () => {
		const messages = project([
			prompt(0, 'before handoff', 'run-0'),
			completion(1, [{ type: 'text', id: 'old', text: 'old answer' }], 'run-0'),
			prompt(2, 'after handoff', 'run-2')
		]);
		expect(messages.map((message) => message._id)).toEqual([
			'prompt:run-0',
			'response:run-0',
			'prompt:run-2'
		]);
		expect(messages.map((message) => message.sourceNumbers)).toEqual([[0], [1], [2]]);
	});
});
