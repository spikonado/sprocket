import { describe, expect, it } from 'vitest';
import type { Id } from '$convex/_generated/dataModel';
import type { LiveCompletionOverlay, LocalTranscriptPart } from '$lib/types/sprocket';
import {
	mergePagedTranscriptWithLive,
	mergeTranscriptParts,
	messagesFromTranscriptParts
} from '$lib/project/transcript';

function threadRecordId(value: string): Id<'threadRecords'> {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return value as Id<'threadRecords'>;
}

function runId(value: string): Id<'runs'> {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return value as Id<'runs'>;
}

function part(
	overrides: Partial<LocalTranscriptPart> & Pick<LocalTranscriptPart, 'number' | 'kind'>
): LocalTranscriptPart {
	return {
		sourceKey: `part:${overrides.number}`,
		runId: runId('run-1'),
		...overrides
	};
}

function lastLive(args: {
	threadId: Id<'threadRecords'>;
	override: Omit<LiveCompletionOverlay, 'threadId'>;
}): LiveCompletionOverlay {
	return { threadId: args.threadId, ...args.override };
}

describe('messagesFromTranscriptParts', () => {
	it('orders prompts, completions, and tools into chat messages', () => {
		const messages = messagesFromTranscriptParts({
			userId: 'user_1',
			threadId: threadRecordId('thread-1'),
			parts: [
				part({
					number: 0,
					kind: 'prompt',
					prompt: { text: 'Hi', imageUploads: [] }
				}),
				part({
					number: 1,
					kind: 'completion',
					completion: {
						streamId: 's1',
						items: [{ type: 'text', id: 't', text: 'Hello', turnId: 's1' }]
					}
				}),
				part({
					number: 2,
					kind: 'tool',
					tool: {
						callId: 'c1',
						name: 'exec_command',
						output: 'ok',
						status: 'completed'
					}
				}),
				part({
					number: 3,
					kind: 'completion',
					completion: {
						streamId: 's2',
						items: [{ type: 'text', id: 't2', text: 'Done', turnId: 's2' }]
					}
				})
			]
		});
		expect(messages.map((message) => message.type)).toEqual(['prompt', 'response']);
		expect(messages[0]?.text).toBe('Hi');
		expect(messages[1]?.text).toBe('HelloDone');
		expect(messages[1]?.parts.map((entry) => entry.type)).toEqual(['text', 'tool-result', 'text']);
	});
});

describe('mergePagedTranscriptWithLive', () => {
	it('keeps the live completion while reconnecting after a thread switch', () => {
		const initial = lastLive({
			threadId: threadRecordId('thread-a'),
			override: {
				runId: runId('run-1'),
				runStatus: 'running',
				streamId: 's1',
				text: 'working',
				parts: [{ type: 'text', id: 't', text: 'working', turnId: 's1' }],
				runStartedAt: 200_000
			}
		});
		const restored = mergePagedTranscriptWithLive({
			parts: [],
			live: initial,
			latestRun: null,
			liveRestore: { threadId: threadRecordId('thread-b'), overlay: null },
			userId: 'user_1',
			threadId: threadRecordId('thread-b')
		});
		expect(restored).toEqual([]);

		const kept = mergePagedTranscriptWithLive({
			parts: [
				part({
					number: 0,
					kind: 'prompt',
					runId: runId('run-0'),
					prompt: { text: 'Hi', imageUploads: [] }
				}),
				part({
					number: 1,
					kind: 'completion',
					runId: runId('run-0'),
					completion: { items: [{ type: 'text', id: 't', text: 'Hello', turnId: 's0' }] }
				})
			],
			live: null,
			latestRun: null,
			liveRestore: {
				threadId: threadRecordId('thread-a'),
				overlay: initial
			},
			userId: 'user_1',
			threadId: threadRecordId('thread-a')
		});
		expect(kept).toHaveLength(3);
		expect(kept.map((message) => message.type)).toEqual(['prompt', 'response', 'response']);
	});

	it('keeps the live overlay while the same thread reconnects', () => {
		const live = lastLive({
			threadId: threadRecordId('thread-1'),
			override: {
				runId: runId('run-1'),
				runStatus: 'running',
				streamId: 's1',
				text: 'working',
				parts: [{ type: 'text', id: 't', text: 'working', turnId: 's1' }],
				runStartedAt: 200_000
			}
		});
		const result = mergePagedTranscriptWithLive({
			parts: [
				part({
					number: 0,
					kind: 'prompt',
					runId: runId('run-1'),
					prompt: { text: 'Do it', imageUploads: [] }
				}),
				part({
					number: 1,
					kind: 'tool',
					runId: runId('run-1'),
					tool: {
						callId: 'c1',
						name: 'exec_command',
						output: 'ok',
						status: 'completed'
					}
				})
			],
			live: null,
			latestRun: {
				_id: runId('run-1'),
				status: 'running',
				startedAt: 200_000
			},
			liveRestore: { threadId: threadRecordId('thread-1'), overlay: live },
			userId: 'user_1',
			threadId: threadRecordId('thread-1')
		});
		expect(result.map((message) => message.type)).toEqual(['prompt', 'response']);
		expect(result.at(-1)?.text).toBe('working');
	});

	it('never places the live run prompt below its own response', () => {
		const messages = mergePagedTranscriptWithLive({
			parts: [
				part({
					number: 0,
					kind: 'completion',
					runId: runId('run-1'),
					completion: { items: [{ type: 'text', id: 't', text: 'working', turnId: 's1' }] }
				})
			],
			live: null,
			latestRun: {
				_id: runId('run-1'),
				status: 'running',
				startedAt: 200_000
			},
			latestPrompt: { text: 'Do it', imageUploadIds: [] },
			userId: 'user_1',
			threadId: threadRecordId('thread-1')
		});
		expect(messages.map((message) => message.type)).toEqual(['prompt', 'response']);
		expect(messages[0]?.text).toBe('Do it');
		expect(messages[0]?.runStatus).toBe('running');
		expect(messages[1]?.text).toBe('working');
	});

	it('keeps the live completion until the matching finalized record is present', () => {
		const live: LiveCompletionOverlay = {
			threadId: threadRecordId('thread-1'),
			runId: runId('run-1'),
			runStatus: 'running',
			streamId: 's1',
			text: 'partial',
			parts: [{ type: 'text', id: 't', text: 'partial', turnId: 's1' }],
			runStartedAt: 10
		};
		const withoutFinal = mergePagedTranscriptWithLive({
			parts: [
				part({
					number: 0,
					kind: 'prompt',
					prompt: { text: 'Hi', imageUploads: [] }
				})
			],
			live,
			latestRun: {
				_id: runId('run-1'),
				status: 'failed',
				startedAt: 10
			},
			userId: 'user_1',
			threadId: threadRecordId('thread-1')
		});
		expect(withoutFinal.at(-1)?.text).toBe('partial');
		expect(withoutFinal.at(-1)?.runStatus).toBe('failed');

		const withFinal = mergePagedTranscriptWithLive({
			parts: [
				part({
					number: 0,
					kind: 'prompt',
					prompt: { text: 'Hi', imageUploads: [] }
				}),
				part({
					number: 1,
					kind: 'completion',
					completion: {
						streamId: 's1',
						items: [{ type: 'text', id: 't', text: 'done', turnId: 's1' }]
					}
				})
			],
			live,
			latestRun: null,
			userId: 'user_1',
			threadId: threadRecordId('thread-1')
		});
		expect(withFinal.at(-1)?.text).toBe('done');
		expect(withoutFinal.at(-1)?._id).toBe(withFinal.at(-1)?._id);
		expect(withoutFinal.at(-1)?.order).toBe(10);
	});

	it('keeps replica tool results while the live overlay is still streaming', () => {
		const live: LiveCompletionOverlay = {
			threadId: threadRecordId('thread-1'),
			runId: runId('run-1'),
			runStatus: 'running',
			streamId: 's2',
			text: 'working',
			parts: [{ type: 'text', id: 't', text: 'working', turnId: 's2' }],
			runStartedAt: 10
		};
		const messages = mergePagedTranscriptWithLive({
			parts: [
				part({
					number: 0,
					kind: 'prompt',
					prompt: { text: 'Hi', imageUploads: [] }
				}),
				part({
					number: 1,
					kind: 'tool',
					tool: {
						callId: 'c1',
						name: 'exec_command',
						output: 'ok',
						status: 'completed'
					}
				})
			],
			live,
			latestRun: {
				_id: runId('run-1'),
				status: 'running',
				startedAt: 10
			},
			userId: 'user_1',
			threadId: threadRecordId('thread-1')
		});
		const response = messages.find((message) => message.type === 'response');
		expect(response?.parts.map((entry) => entry.type)).toEqual(['tool-result', 'text']);
	});

	it('keeps earlier finalized turns while a later stream is live', () => {
		const live: LiveCompletionOverlay = {
			threadId: threadRecordId('thread-1'),
			runId: runId('run-1'),
			runStatus: 'running',
			streamId: 's2',
			text: 'working',
			parts: [{ type: 'text', id: 't2', text: 'working', turnId: 's2' }],
			runStartedAt: 10
		};
		const messages = mergePagedTranscriptWithLive({
			parts: [
				part({
					number: 0,
					kind: 'prompt',
					prompt: { text: 'Hi', imageUploads: [] }
				}),
				part({
					number: 1,
					kind: 'completion',
					completion: {
						streamId: 's1',
						items: [{ type: 'text', id: 't1', text: 'Hello', turnId: 's1' }]
					}
				}),
				part({
					number: 2,
					kind: 'tool',
					tool: {
						callId: 'c1',
						name: 'exec_command',
						output: 'ok',
						status: 'completed'
					}
				})
			],
			live,
			latestRun: {
				_id: runId('run-1'),
				status: 'running',
				startedAt: 10
			},
			userId: 'user_1',
			threadId: threadRecordId('thread-1')
		});
		const response = messages.find((message) => message.type === 'response');
		expect(response?.text).toBe('Hello\n\nworking');
		expect(response?.parts.map((entry) => entry.type)).toEqual(['text', 'tool-result', 'text']);
	});

	it('applies latest-run status onto the matching replica messages', () => {
		const messages = mergePagedTranscriptWithLive({
			parts: [
				part({
					number: 0,
					kind: 'prompt',
					prompt: { text: 'Hi', imageUploads: [] }
				})
			],
			live: null,
			latestRun: {
				_id: runId('run-1'),
				status: 'running',
				startedAt: 50
			},
			userId: 'user_1',
			threadId: threadRecordId('thread-1')
		});
		expect(messages[0]?.runStatus).toBe('running');
		expect(messages[0]?.runStartedAt).toBe(50);
	});
});

describe('mergeTranscriptParts', () => {
	it('keeps already-fetched parts when an older page arrives', () => {
		const merged = mergeTranscriptParts(
			[part({ number: 2, kind: 'prompt', prompt: { text: 'new', imageUploads: [] } })],
			[part({ number: 0, kind: 'prompt', prompt: { text: 'old', imageUploads: [] } })]
		);
		expect(merged.map((entry) => entry.prompt?.text)).toEqual(['old', 'new']);
	});
});
