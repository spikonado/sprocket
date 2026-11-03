import { describe, expect, it } from 'vitest';
import type { LiveCompletionOverlay } from '$lib/types/sprocket';
import { mergeLiveOverlays } from './transcript';
import { fixtureId } from '$lib/convex-test-client';

function overlay(streamId: string, text: string): LiveCompletionOverlay {
	return {
		threadId: fixtureId<'threadRecords'>('thread'),
		runId: fixtureId<'runs'>('run'),
		streamId,
		runStatus: 'running',
		text,
		parts: [{ type: 'text', id: 'text', turnId: streamId, text }]
	};
}

describe('mergeLiveOverlays', () => {
	it('keeps repeated text IDs in distinct turns and replaces updates without reordering', () => {
		const messages = mergeLiveOverlays([
			overlay('a', 'First'),
			overlay('b', 'Second'),
			overlay('a', 'Updated')
		]);

		expect(messages).toHaveLength(1);
		expect(messages[0].parts).toEqual([
			...overlay('a', 'Updated').parts,
			...overlay('b', 'Second').parts
		]);
		expect(messages[0].text).toBe('Updated\n\nSecond');
	});

	it('does not reorder reasoning or tool calls between text parts', () => {
		const live = overlay('a', 'First');
		live.parts.push(
			{ type: 'reasoning', id: 'r', text: 'Thinking' },
			{ type: 'tool-call', callId: 'call', name: 'read', input: {} }
		);
		expect(mergeLiveOverlays([live, overlay('b', 'Second')])[0].parts).toEqual([
			...live.parts,
			...overlay('b', 'Second').parts
		]);
	});
});
