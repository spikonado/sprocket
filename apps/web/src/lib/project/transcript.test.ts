import { describe, expect, it } from 'vitest';
import type { Id } from '$convex/_generated/dataModel';
import type { ThreadMessage } from '$lib/types/sprocket';
import { mergeThreadTranscriptMessages } from '$lib/project/transcript';

function message(
	overrides: Partial<ThreadMessage> & Pick<ThreadMessage, '_id' | 'type'>
): ThreadMessage {
	return {
		threadId: 'thread-1' as Id<'threadRecords'>,
		runId: 'run-1' as Id<'runs'>,
		userId: 'user_1',
		text: '',
		attachments: [],
		runStatus: 'completed',
		runStartedAt: 1,
		...overrides
	};
}

describe('mergeThreadTranscriptMessages', () => {
	it('merges history and live in chronological order with live winning duplicates', () => {
		const history = [
			message({
				_id: 'm1' as Id<'threadMessages'>,
				type: 'prompt',
				runStartedAt: 10,
				text: 'stale',
				runStatus: 'completed'
			}),
			message({
				_id: 'm2' as Id<'threadMessages'>,
				type: 'response',
				runStartedAt: 10,
				_creationTime: 2,
				text: 'b'
			})
		];
		const live = [
			message({
				_id: 'm1' as Id<'threadMessages'>,
				type: 'prompt',
				runStartedAt: 10,
				text: 'fresh',
				runStatus: 'running'
			}),
			message({
				_id: 'm3' as Id<'threadMessages'>,
				type: 'prompt',
				runStartedAt: 20,
				runStatus: 'running',
				text: 'c'
			})
		];

		expect(mergeThreadTranscriptMessages({ historyMessages: history, liveMessages: live })).toEqual(
			[live[0], history[1], live[1]]
		);
	});

	it('drops whole oldest runs instead of orphaning a response when live exceeds the window', () => {
		const history = Array.from({ length: 40 }, (_, index) =>
			message({
				_id: `h${index}` as Id<'threadMessages'>,
				type: index % 2 === 0 ? 'prompt' : 'response',
				runId: `run-${Math.floor(index / 2)}` as Id<'runs'>,
				runStartedAt: Math.floor(index / 2),
				text: `h${index}`
			})
		);
		const live = [
			message({
				_id: 'live-prompt' as Id<'threadMessages'>,
				type: 'prompt',
				runId: 'run-live' as Id<'runs'>,
				runStartedAt: 100,
				runStatus: 'queued',
				text: 'new'
			})
		];

		const merged = mergeThreadTranscriptMessages({
			historyMessages: history,
			liveMessages: live
		});
		expect(merged.map((entry) => entry._id)).not.toContain(history[0]?._id);
		expect(merged.map((entry) => entry._id)).not.toContain(history[1]?._id);
		expect(merged[0]?.type).toBe('prompt');
		expect(merged.at(-1)?.text).toBe('new');
		expect(merged).toHaveLength(39);
	});
});
