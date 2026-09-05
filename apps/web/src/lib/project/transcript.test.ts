import { describe, expect, it } from 'vitest';
import type { Id } from '$convex/_generated/dataModel';
import type { LiveCompletionOverlay, ThreadMessage } from '$lib/types/sprocket';
import { mergePagedTranscriptWithLive, mergeTranscriptMessages } from '$lib/project/transcript';
import { buildAssistantTimeline } from '$lib/chat/assistant-timeline';

// SAFETY: Tests use stable opaque strings where only ID equality matters.
const threadId = 'thread-1' as Id<'threadRecords'>;
// SAFETY: Tests use stable opaque strings where only ID equality matters.
const runId = 'run-1' as Id<'runs'>;

function message(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
	return {
		_id: 'response:run-1',
		threadId,
		runId,
		userId: 'user-1',
		type: 'response',
		text: 'done',
		attachments: [],
		parts: [{ type: 'text', id: 'done', text: 'done' }],
		runStatus: 'completed',
		runStartedAt: 1,
		sourceNumbers: [1],
		streamIds: ['stream-1'],
		detailsLoaded: false,
		...overrides
	};
}

function live(): LiveCompletionOverlay {
	return {
		threadId,
		runId,
		runStatus: 'running',
		streamId: 'stream-1',
		text: 'working',
		parts: [{ type: 'text', id: 'live', text: 'working', turnId: 'stream-1' }],
		runStartedAt: 2
	};
}

describe('mergePagedTranscriptWithLive', () => {
	it('keeps completed messages referentially stable on each streamed update', () => {
		const old = message({ _id: 'prompt:run-1', type: 'prompt' });
		const messages = mergePagedTranscriptWithLive({
			messages: [old],
			live: live(),
			userId: 'user-1',
			threadId
		});
		expect(messages[0]).toBe(old);
	});

	it('keeps the prior streamed turn visible until history acknowledges it', () => {
		const previous = live();
		const next = {
			...live(),
			streamId: 'stream-2',
			parts: [{ type: 'text' as const, id: 'next', text: 'next', turnId: 'stream-2' }]
		};
		const args = { live: next, pending: [previous], userId: 'user-1', threadId };
		const before = mergePagedTranscriptWithLive({ ...args, messages: [] });
		expect(before[0].text).toBe('working\n\nnext');
		const after = mergePagedTranscriptWithLive({
			...args,
			messages: [message({ parts: previous.parts })]
		});
		expect(after[0].text).toBe('working\n\nnext');
		expect(after[0].sourceNumbers).toEqual([1]);
	});

	it('keeps durable tool results attached to their streamed calls', () => {
		const call = { type: 'tool-call' as const, callId: 'call', name: 'exec_command', input: null };
		const result = {
			type: 'tool-result' as const,
			callId: 'call',
			name: 'exec_command',
			output: 'done'
		};
		const messages = mergePagedTranscriptWithLive({
			messages: [message({ streamIds: [], parts: [call, result], sourceNumbers: [1, 2] })],
			live: { ...live(), parts: [{ ...call, input: { cmd: 'pwd' } }] },
			userId: 'user-1',
			threadId
		});
		expect(messages[0].parts.map((part) => part.type)).toEqual(['tool-call', 'tool-result']);
		expect(messages[0].sourceNumbers).toEqual([1, 2]);
	});

	it('keeps reasoning before its tools when tool events arrive before the completion', () => {
		const reasoning = { type: 'reasoning' as const, id: 'r', turnId: 'stream-1', text: 'plan' };
		const text = { type: 'text' as const, id: 't', turnId: 'stream-1', text: 'checking' };
		const first = { type: 'tool-call' as const, callId: 'a', name: 'exec_command', input: null };
		const second = { ...first, callId: 'b' };
		const result = {
			type: 'tool-result' as const,
			callId: 'a',
			name: 'exec_command',
			output: 'done'
		};
		const stream = { ...live(), parts: [reasoning, text, first, second] };
		const previous = { type: 'text' as const, id: 'previous', text: 'previous turn' };
		const args = { live: stream, userId: 'user-1', threadId };
		const before = mergePagedTranscriptWithLive({
			...args,
			messages: [message({ parts: [previous], streamIds: [] })]
		});
		const during = mergePagedTranscriptWithLive({
			...args,
			messages: [message({ parts: [previous, second, first, result], streamIds: [] })]
		});
		expect(during[0].parts).toEqual([previous, reasoning, text, first, result, second]);
		const order = (entry: ThreadMessage) =>
			buildAssistantTimeline(entry.parts, []).map((part) =>
				part.type === 'tool' ? part.callId : part.id
			);
		expect(order(during[0])).toEqual(order(before[0]));
		const completed = message({ parts: during[0].parts });
		expect(order(mergePagedTranscriptWithLive({ ...args, messages: [completed] })[0])).toEqual(
			order(before[0])
		);
		expect(during[0].parts.filter((part) => part.type === 'tool-result')).toEqual([result]);
	});

	it('does not duplicate a response after its durable message arrives', () => {
		expect(
			mergePagedTranscriptWithLive({
				messages: [message()],
				live: live(),
				userId: 'user-1',
				threadId
			})
		).toHaveLength(1);
	});

	it('adds a live response when no durable response exists', () => {
		const messages = mergePagedTranscriptWithLive({
			messages: [],
			live: live(),
			userId: 'user-1',
			threadId
		});
		expect(messages.map((entry) => entry.text)).toEqual(['working']);
	});
});

describe('mergeTranscriptMessages', () => {
	it('does not re-render immutable messages when the same source snapshot is refreshed', () => {
		const current = message();
		expect(mergeTranscriptMessages([current], [message()])[0]).toBe(current);
	});

	it('hydrates an older snapshot without erasing new output, and retains it on later refreshes', () => {
		const reasoning = { type: 'reasoning' as const, id: 'reasoning', text: '' };
		const latest = message({ sourceNumbers: [1, 2], parts: [reasoning, ...message().parts] });
		const details = message({
			sourceNumbers: [1],
			detailsLoaded: true,
			parts: [{ ...reasoning, text: 'details' }]
		});
		const merged = mergeTranscriptMessages([latest], [details]);
		expect(merged[0].parts).toEqual([{ ...reasoning, text: 'details' }, ...message().parts]);
		expect(merged[0].sourceNumbers).toEqual([1, 2]);
		expect(merged[0].detailsLoaded).toBe(false);
		expect(mergeTranscriptMessages(merged, [latest])[0].parts).toEqual(merged[0].parts);
	});
	it('merges pages by message id and source order', () => {
		const newer = message({ _id: 'prompt:run-2', type: 'prompt', sourceNumbers: [4] });
		const older = message({ _id: 'prompt:run-1', type: 'prompt', sourceNumbers: [0] });
		expect(mergeTranscriptMessages([newer], [older]).map((entry) => entry._id)).toEqual([
			'prompt:run-1',
			'prompt:run-2'
		]);
	});

	it('replaces a lightweight message with its detailed version', () => {
		const lightweight = message({ parts: [], detailsLoaded: false, sourceNumbers: [1, 2] });
		const detailed = message({
			parts: [{ type: 'reasoning', id: 'reasoning-1', text: 'details' }],
			detailsLoaded: true,
			sourceNumbers: [1, 2]
		});

		expect(mergeTranscriptMessages([lightweight], [detailed])).toEqual([detailed]);
	});
});
