import { describe, expect, it } from 'vitest';
import {
	assistantTimelineToolError,
	assistantTimelineToolFailureKind,
	buildAssistantTimeline
} from '$lib/chat/assistant-timeline';
import type { ExecutorJob } from '$lib/types/sprocket';

function executorJob(
	id: string,
	sequence: number,
	overrides: Partial<ExecutorJob> = {}
): ExecutorJob {
	return {
		_id: id as ExecutorJob['_id'],
		workspaceSessionId: 'workspace' as ExecutorJob['workspaceSessionId'],
		threadId: 'thread' as ExecutorJob['threadId'],
		runId: 'run' as ExecutorJob['runId'],
		kind: 'exec_command',
		payload: { cmd: id },
		hidden: false,
		status: 'pending',
		enqueuedAt: sequence,
		sequence,
		...overrides
	};
}

describe('assistant timeline', () => {
	it('keeps tool calls between surrounding assistant parts and pairs results', () => {
		const timeline = buildAssistantTimeline(
			[
				{ type: 'reasoning', id: 'r1', text: 'Thinking' },
				{ type: 'tool-call', callId: 'call-1', name: 'exec_command', input: { cmd: 'pwd' } },
				{
					type: 'tool-result',
					callId: 'call-1',
					name: 'exec_command',
					output: { output: '/workspace' }
				},
				{ type: 'text', id: 't1', text: 'Done' }
			],
			[]
		);

		expect(timeline.map((item) => item.type)).toEqual(['reasoning', 'tool', 'text']);
		expect(timeline[1]).toMatchObject({
			type: 'tool',
			callId: 'call-1',
			output: { output: '/workspace' }
		});
	});

	it('correlates reversed same-name jobs by payload and keeps remaining jobs visible', () => {
		const first = executorJob('job-1', 1, { payload: { cmd: 'one' } });
		const second = executorJob('job-2', 2, { payload: { cmd: 'two' } });
		const remaining = executorJob('job-3', 3, {
			kind: 'create_file',
			payload: { path: 'new.txt', content: 'content' }
		});
		const timeline = buildAssistantTimeline(
			[
				{ type: 'tool-call', callId: 'call-1', name: 'exec_command', input: { cmd: 'one' } },
				{ type: 'tool-call', callId: 'call-2', name: 'exec_command', input: { cmd: 'two' } }
			],
			[second, first, remaining]
		);

		expect(timeline).toHaveLength(3);
		expect(timeline[0]).toMatchObject({ type: 'tool', job: { _id: first._id } });
		expect(timeline[1]).toMatchObject({ type: 'tool', job: { _id: second._id } });
		expect(timeline[2]).toMatchObject({ type: 'tool', job: { _id: remaining._id } });
	});

	it('keeps ambiguous same-name jobs separate from streamed calls', () => {
		const first = executorJob('job-1', 1, { payload: { cmd: 'persisted-one' } });
		const second = executorJob('job-2', 2, { payload: { cmd: 'persisted-two' } });
		const timeline = buildAssistantTimeline(
			[
				{
					type: 'tool-call',
					callId: 'call-1',
					name: 'exec_command',
					input: { cmd: 'streamed-one' }
				},
				{
					type: 'tool-call',
					callId: 'call-2',
					name: 'exec_command',
					input: { cmd: 'streamed-two' }
				}
			],
			[first, second]
		);

		expect(timeline).toHaveLength(4);
		expect(timeline.slice(0, 2)).toEqual([
			expect.not.objectContaining({ job: expect.anything() }),
			expect.not.objectContaining({ job: expect.anything() })
		]);
		expect(timeline.slice(2)).toEqual([
			expect.objectContaining({ job: expect.objectContaining({ _id: first._id }) }),
			expect.objectContaining({ job: expect.objectContaining({ _id: second._id }) })
		]);
	});

	it('exposes errors from persisted tool results when no live job exists', () => {
		const [tool] = buildAssistantTimeline(
			[
				{ type: 'tool-call', callId: 'call-1', name: 'exec_command', input: { cmd: 'false' } },
				{
					type: 'tool-result',
					callId: 'call-1',
					output: { error: 'command failed', status: 'failed' }
				}
			],
			[]
		);

		expect(tool).toMatchObject({ type: 'tool' });
		if (tool?.type !== 'tool') throw new Error('Expected a tool timeline item.');
		expect(assistantTimelineToolError(tool)).toBe('command failed');
	});

	it('exposes the error or cancelled state for live cancelled jobs', () => {
		const [cancelled, cancelledWithError] = buildAssistantTimeline(
			[],
			[
				executorJob('job-1', 1, { status: 'cancelled' }),
				executorJob('job-2', 2, { status: 'cancelled', error: 'stopped by user' })
			]
		);

		expect(cancelled).toMatchObject({ type: 'tool' });
		expect(cancelledWithError).toMatchObject({ type: 'tool' });
		if (cancelled?.type !== 'tool' || cancelledWithError?.type !== 'tool') {
			throw new Error('Expected tool timeline items.');
		}
		expect(assistantTimelineToolError(cancelled)).toBe('Executor job cancelled before completion.');
		expect(assistantTimelineToolError(cancelledWithError)).toBe('stopped by user');
		expect(assistantTimelineToolFailureKind(cancelled)).toBe('cancelled');
		expect(assistantTimelineToolFailureKind(cancelledWithError)).toBe('cancelled');
	});

	it('falls back to the failed state when a failed live job has no error', () => {
		const [failed] = buildAssistantTimeline([], [executorJob('job-1', 1, { status: 'failed' })]);

		expect(failed).toMatchObject({ type: 'tool' });
		if (failed?.type !== 'tool') throw new Error('Expected a tool timeline item.');
		expect(assistantTimelineToolError(failed)).toBe('Executor job failed.');
		expect(assistantTimelineToolFailureKind(failed)).toBe('failed');
	});

	it('labels persisted tool-result errors as failed, not cancelled', () => {
		const [tool] = buildAssistantTimeline(
			[
				{ type: 'tool-call', callId: 'call-1', name: 'exec_command', input: { cmd: 'false' } },
				{
					type: 'tool-result',
					callId: 'call-1',
					output: { error: 'command failed', status: 'failed' }
				}
			],
			[]
		);

		expect(tool).toMatchObject({ type: 'tool' });
		if (tool?.type !== 'tool') throw new Error('Expected a tool timeline item.');
		expect(assistantTimelineToolFailureKind(tool)).toBe('failed');
	});

	it('preserves cancelled vs failed from persisted tool-result status after jobs leave the timeline', () => {
		const [cancelled, failed] = buildAssistantTimeline(
			[
				{ type: 'tool-call', callId: 'call-1', name: 'exec_command', input: { cmd: 'one' } },
				{
					type: 'tool-result',
					callId: 'call-1',
					output: { error: 'stopped by user', status: 'cancelled' }
				},
				{ type: 'tool-call', callId: 'call-2', name: 'exec_command', input: { cmd: 'two' } },
				{
					type: 'tool-result',
					callId: 'call-2',
					output: { error: 'command failed', status: 'failed' }
				}
			],
			[]
		);

		expect(cancelled).toMatchObject({ type: 'tool' });
		expect(failed).toMatchObject({ type: 'tool' });
		if (cancelled?.type !== 'tool' || failed?.type !== 'tool') {
			throw new Error('Expected tool timeline items.');
		}
		expect(assistantTimelineToolFailureKind(cancelled)).toBe('cancelled');
		expect(assistantTimelineToolError(cancelled)).toBe('stopped by user');
		expect(assistantTimelineToolFailureKind(failed)).toBe('failed');
		expect(assistantTimelineToolError(failed)).toBe('command failed');
	});
});
