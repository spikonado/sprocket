import { describe, expect, it } from 'vitest';
import {
	appendCompletionStreamEvent,
	classifyCompletionStreamBatch,
	COMPLETION_STREAM_SUPERSEDED,
	type CompletionStreamEvent,
	isCompletionStreamAttemptSuperseded,
	isCompletionStreamSuperseded,
	upsertCompletionReasoningEvent,
	upsertCompletionTextEvent
} from '@convex/lib/completionStream';

describe('completion stream reducer', () => {
	it('only accepts a retry when both its stream attempt and batch sequence match', () => {
		expect(
			classifyCompletionStreamBatch({
				lastSequence: 4,
				lastStreamId: 'attempt-a',
				sequence: 4,
				streamId: 'attempt-a'
			})
		).toBe('duplicate');
		expect(
			classifyCompletionStreamBatch({
				lastSequence: 4,
				lastStreamId: 'attempt-a',
				sequence: 3,
				streamId: 'attempt-a'
			})
		).toBe('duplicate');
		expect(
			classifyCompletionStreamBatch({
				lastSequence: 4,
				lastStreamId: 'attempt-a',
				sequence: 4,
				streamId: 'attempt-b'
			})
		).toBe('superseded');
		expect(
			classifyCompletionStreamBatch({
				lastSequence: 4,
				lastStreamId: 'attempt-a',
				sequence: 5,
				streamId: 'attempt-b'
			})
		).toBe('append');
	});

	it('supersedes a different attempt behind the claimed sequence but keeps true gaps as errors', () => {
		expect(
			classifyCompletionStreamBatch({
				lastSequence: 6,
				lastStreamId: 'attempt-a',
				sequence: 4,
				streamId: 'attempt-b'
			})
		).toBe('superseded');
		expect(() =>
			classifyCompletionStreamBatch({
				lastSequence: 6,
				lastStreamId: 'attempt-a',
				sequence: 8,
				streamId: 'attempt-a'
			})
		).toThrow(/expected 7/);
		expect(
			isCompletionStreamSuperseded(
				new Error(`Convex action failed: ${COMPLETION_STREAM_SUPERSEDED}`)
			)
		).toBe(true);
	});

	it('only supersedes a stream after another attempt advances its starting sequence', () => {
		expect(
			isCompletionStreamAttemptSuperseded({
				initialSequence: 4,
				observedSequence: 4,
				observedStreamId: 'previous-attempt',
				streamId: 'current-attempt'
			})
		).toBe(false);
		expect(
			isCompletionStreamAttemptSuperseded({
				initialSequence: 4,
				observedSequence: 5,
				observedStreamId: 'current-attempt',
				streamId: 'current-attempt'
			})
		).toBe(false);
		expect(
			isCompletionStreamAttemptSuperseded({
				initialSequence: 4,
				observedSequence: 5,
				observedStreamId: 'replacement-attempt',
				streamId: 'current-attempt'
			})
		).toBe(true);
		expect(
			isCompletionStreamAttemptSuperseded({
				initialSequence: 4,
				observedSequence: 5,
				streamId: 'current-attempt'
			})
		).toBe(true);
	});

	it('coalesces text while retaining the newest metadata', () => {
		const events: CompletionStreamEvent[] = [
			{ type: 'reasoning', id: 'reasoning-1', text: 'first', turnId: 'old' }
		];
		appendCompletionStreamEvent(events, {
			type: 'reasoning',
			id: 'reasoning-1',
			text: ' second',
			turnId: 'new',
			providerReasoningId: 'rs_123',
			providerMetadata: { openai: { itemId: 'rs_123' } }
		});

		expect(events).toEqual([
			{
				type: 'reasoning',
				id: 'reasoning-1',
				text: 'first second',
				turnId: 'new',
				providerReasoningId: 'rs_123',
				providerMetadata: { openai: { itemId: 'rs_123' } }
			}
		]);
	});

	it('retains turn and provider metadata on returned text events', () => {
		const events: CompletionStreamEvent[] = [];
		appendCompletionStreamEvent(events, {
			type: 'text',
			id: 'text-1',
			text: 'Hello',
			turnId: 'turn-1',
			providerMetadata: { openai: { itemId: 'msg_123' } }
		});

		expect(events).toEqual([
			{
				type: 'text',
				id: 'text-1',
				text: 'Hello',
				turnId: 'turn-1',
				providerMetadata: { openai: { itemId: 'msg_123' } }
			}
		]);
	});

	it('updates a text placeholder in place with delta and boundary metadata', () => {
		const events: CompletionStreamEvent[] = [];
		upsertCompletionTextEvent(events, {
			type: 'text',
			id: 'text-1',
			text: '',
			turnId: 'turn-1',
			providerMetadata: { openai: { itemId: 'start-item' } }
		});
		appendCompletionStreamEvent(events, {
			type: 'toolCall',
			partId: 'tool-1',
			callId: 'call-1',
			name: 'exec_command',
			input: { cmd: 'pwd' }
		});
		upsertCompletionTextEvent(events, {
			type: 'text',
			id: 'text-1',
			text: 'Hello'
		});
		upsertCompletionTextEvent(events, {
			type: 'text',
			id: 'text-1',
			text: '',
			providerMetadata: { openai: { itemId: 'end-item' } }
		});

		expect(events.map((event) => event.type)).toEqual(['text', 'toolCall']);
		expect(events[0]).toEqual({
			type: 'text',
			id: 'text-1',
			text: 'Hello',
			turnId: 'turn-1',
			providerMetadata: { openai: { itemId: 'end-item' } }
		});
	});

	it('keeps reasoning before a tool call when reasoning metadata arrives later', () => {
		const events: CompletionStreamEvent[] = [];
		upsertCompletionReasoningEvent(events, {
			type: 'reasoning',
			id: 'reasoning-1',
			text: 'Thinking'
		});
		appendCompletionStreamEvent(events, {
			type: 'toolCall',
			partId: 'tool-1',
			callId: 'call-1',
			name: 'exec_command',
			input: { cmd: 'pwd' }
		});
		upsertCompletionReasoningEvent(events, {
			type: 'reasoning',
			id: 'reasoning-1',
			text: '',
			providerReasoningId: 'rs_123'
		});

		expect(events.map((event) => event.type)).toEqual(['reasoning', 'toolCall']);
		expect(events[0]).toMatchObject({
			text: 'Thinking',
			providerReasoningId: 'rs_123'
		});
	});
});
