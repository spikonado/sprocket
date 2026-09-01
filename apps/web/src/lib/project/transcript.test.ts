import { describe, expect, it } from 'vitest';
import type { Id } from '$convex/_generated/dataModel';
import type { LiveCompletionOverlay, LocalTranscriptPart } from '$lib/types/sprocket';
import {
	mergePagedTranscriptWithLive,
	mergeTranscriptParts,
	messagesFromTranscriptParts
} from '$lib/project/transcript';

// SAFETY: Tests use stable opaque strings where only ID equality matters.
const threadId = (value = 'thread-1') => value as Id<'threadRecords'>;
// SAFETY: Tests use stable opaque strings where only ID equality matters.
const runId = (value = 'run-1') => value as Id<'runs'>;
// SAFETY: Tests use stable opaque strings where only ID equality matters.
const jobId = (value = 'job-1') => value as Id<'executorJobs'>;

function part(
	overrides: Partial<LocalTranscriptPart> & Pick<LocalTranscriptPart, 'number' | 'kind'>
): LocalTranscriptPart {
	return { sourceKey: `part:${overrides.number}`, runId: runId(), ...overrides };
}

function live(overrides: Partial<LiveCompletionOverlay> = {}): LiveCompletionOverlay {
	return {
		threadId: threadId(),
		runId: runId(),
		runStatus: 'running',
		streamId: 's2',
		text: 'working',
		parts: [{ type: 'text', id: 't2', text: 'working', turnId: 's2' }],
		runStartedAt: 10,
		...overrides
	};
}

describe('messagesFromTranscriptParts', () => {
	it('orders durable messages by transcript part number', () => {
		const messages = messagesFromTranscriptParts({
			userId: 'user_1',
			threadId: threadId(),
			parts: [
				part({
					number: 1,
					kind: 'completion',
					completion: { items: [{ type: 'text', id: 't', text: 'Hello', turnId: 's1' }] }
				}),
				part({ number: 0, kind: 'prompt', prompt: { text: 'Hi', imageUploads: [] } })
			]
		});

		expect(messages.map((message) => [message.type, message.text])).toEqual([
			['prompt', 'Hi'],
			['response', 'Hello']
		]);
	});
});

describe('mergePagedTranscriptWithLive', () => {
	it('never displays a live completion from another thread', () => {
		const messages = mergePagedTranscriptWithLive({
			parts: [],
			live: live({ threadId: threadId('thread-a') }),
			userId: 'user_1',
			threadId: threadId('thread-b')
		});

		expect(messages).toEqual([]);
	});

	it('places a numbered replica prompt before its live response', () => {
		const messages = mergePagedTranscriptWithLive({
			parts: [part({ number: 7, kind: 'prompt', prompt: { text: 'Do it', imageUploads: [] } })],
			live: live(),
			userId: 'user_1',
			threadId: threadId()
		});

		expect(messages.map((message) => [message.type, message.text])).toEqual([
			['prompt', 'Do it'],
			['response', 'working']
		]);
	});

	it('suppresses live output once its durable completion is present', () => {
		const messages = mergePagedTranscriptWithLive({
			parts: [
				part({ number: 0, kind: 'prompt', prompt: { text: 'Hi', imageUploads: [] } }),
				part({
					number: 1,
					kind: 'completion',
					completion: {
						streamId: 's2',
						items: [{ type: 'text', id: 'done', text: 'done', turnId: 's2' }]
					}
				})
			],
			live: live(),
			userId: 'user_1',
			threadId: threadId()
		});

		expect(messages.at(-1)?.text).toBe('done');
	});

	it('keeps durable tool results while overlaying the current stream', () => {
		const messages = mergePagedTranscriptWithLive({
			parts: [
				part({ number: 0, kind: 'prompt', prompt: { text: 'Hi', imageUploads: [] } }),
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
			live: live(),
			userId: 'user_1',
			threadId: threadId()
		});

		const response = messages.find((message) => message.type === 'response');
		expect(response?.text).toBe('Hello\n\nworking');
		expect(response?.parts.map((entry) => entry.type)).toEqual([
			'text',
			'tool-call',
			'tool-result',
			'text'
		]);
	});

	it('folds start and finish tool events into one call and one result', () => {
		const messages = messagesFromTranscriptParts({
			userId: 'user_1',
			threadId: threadId(),
			parts: [
				part({ number: 0, kind: 'prompt', prompt: { text: 'Hi', imageUploads: [] } }),
				part({
					number: 1,
					kind: 'tool',
					tool: {
						toolInvocationId: 'inv-1',
						callId: 'c1',
						name: 'exec_command',
						status: 'started'
					}
				}),
				part({
					number: 2,
					kind: 'completion',
					completion: {
						streamId: 's1',
						items: [
							{
								type: 'tool-call',
								callId: 'c1',
								name: 'exec_command',
								input: { cmd: 'pwd' }
							}
						]
					}
				}),
				part({
					number: 3,
					kind: 'tool',
					tool: {
						toolInvocationId: 'inv-1',
						callId: 'c1',
						name: 'exec_command',
						output: 'ok',
						status: 'completed'
					}
				}),
				part({
					number: 4,
					kind: 'tool',
					tool: {
						toolInvocationId: 'inv-1',
						callId: 'c1',
						name: 'exec_command',
						output: 'duplicate',
						status: 'cancelled'
					}
				})
			]
		});

		const response = messages.find((message) => message.type === 'response');
		expect(response?.parts).toEqual([
			{
				type: 'tool-call',
				callId: 'c1',
				name: 'exec_command',
				input: { cmd: 'pwd' }
			},
			{
				type: 'tool-result',
				callId: 'c1',
				name: 'exec_command',
				output: 'ok'
			}
		]);
	});

	it('keeps a started-only tool as an in-progress call without a result', () => {
		const messages = messagesFromTranscriptParts({
			userId: 'user_1',
			threadId: threadId(),
			parts: [
				part({ number: 0, kind: 'prompt', prompt: { text: 'Hi', imageUploads: [] } }),
				part({
					number: 1,
					kind: 'tool',
					tool: {
						toolInvocationId: 'inv-1',
						callId: 'c1',
						name: 'exec_command',
						status: 'started'
					}
				})
			]
		});

		const response = messages.find((message) => message.type === 'response');
		expect(response?.parts).toEqual([
			{ type: 'tool-call', callId: 'c1', name: 'exec_command', input: {} }
		]);
	});

	it('folds a legacy jobId tool part into one result', () => {
		const messages = messagesFromTranscriptParts({
			userId: 'user_1',
			threadId: threadId(),
			parts: [
				part({
					number: 0,
					kind: 'completion',
					completion: {
						items: [{ type: 'tool-call', callId: 'c1', name: 'exec_command', input: {} }]
					}
				}),
				part({
					number: 1,
					kind: 'tool',
					tool: {
						jobId: jobId('job-legacy'),
						callId: 'c1',
						name: 'exec_command',
						output: 'legacy',
						status: 'completed'
					}
				})
			]
		});

		const response = messages.find((message) => message.type === 'response');
		expect(response?.parts.map((entry) => entry.type)).toEqual(['tool-call', 'tool-result']);
		expect(response?.parts[1]).toMatchObject({ output: 'legacy', callId: 'c1' });
	});
});

describe('mergeTranscriptParts', () => {
	it('deduplicates an optimistic prompt when replica sync returns it', () => {
		const prompt = part({ number: 2, kind: 'prompt', prompt: { text: 'new', imageUploads: [] } });
		const merged = mergeTranscriptParts([prompt], [{ ...prompt }]);

		expect(merged).toEqual([prompt]);
	});

	it('keeps already-fetched parts when an older page arrives', () => {
		const merged = mergeTranscriptParts(
			[part({ number: 2, kind: 'prompt', prompt: { text: 'new', imageUploads: [] } })],
			[part({ number: 0, kind: 'prompt', prompt: { text: 'old', imageUploads: [] } })]
		);
		expect(merged.map((entry) => entry.prompt?.text)).toEqual(['old', 'new']);
	});
});
