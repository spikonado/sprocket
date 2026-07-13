import { describe, expect, it } from 'vitest';
import {
	appendCompletionStreamEvent,
	classifyCompletionStreamBatch,
	type CompletionStreamEvent,
	upsertCompletionReasoningEvent,
	upsertCompletionTextEvent
} from '$convex/lib/completionStream';

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
		expect(() =>
			classifyCompletionStreamBatch({
				lastSequence: 4,
				lastStreamId: 'attempt-a',
				sequence: 4,
				streamId: 'attempt-b'
			})
		).toThrow(/cannot reuse batch/);
		expect(
			classifyCompletionStreamBatch({
				lastSequence: 4,
				lastStreamId: 'attempt-a',
				sequence: 5,
				streamId: 'attempt-b'
			})
		).toBe('append');
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
