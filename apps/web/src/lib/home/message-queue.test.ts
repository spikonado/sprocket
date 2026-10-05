import { describe, expect, it, vi } from 'vitest';
import type { Id } from '@convex/_generated/dataModel';
import type { SelectedThreadLifecycle } from '@convex/lib/runCancellation';
import type { AgentRunRequest, AgentRunStart } from '$lib/types/sprocket';
import { MessageQueue } from './message-queue';

function threadId(value = 'thread-1') {
	// SAFETY: fixture ids are only compared as opaque document identifiers.
	return value as Id<'threadRecords'>;
}

function runId(value: string) {
	// SAFETY: fixture ids are only compared as opaque document identifiers.
	return value as Id<'runs'>;
}

function request(id: string, overrides: Partial<AgentRunRequest> = {}) {
	return {
		userId: 'user-1',
		submissionId: id,
		executionSecret: `secret-${id}`,
		prompt: id,
		storageIds: [],
		selectedModel: 'model-one',
		completionProvider: 'openai',
		reasoningEffort: 'high',
		fastMode: false,
		workspacePath: '/project',
		...overrides,
		threadId: overrides.threadId ?? threadId()
	} satisfies AgentRunRequest;
}

function fixture() {
	const queue = new MessageQueue();
	const listeners = new Map<string, (lifecycle: SelectedThreadLifecycle) => void>();
	const errors = new Map<string, (error: Error) => void>();

	const runAgent = vi.fn(async (args: AgentRunRequest): Promise<AgentRunStart> => ({
		runId: runId(`run-${args.submissionId}`),
		threadId: args.threadId ?? threadId()
	}));

	const discardTranscriptAttachment = vi.fn(async () => true);
	const onStarted = vi.fn();

	const context = {
		userId: 'user-1',
		api: { runAgent, discardTranscriptAttachment },
		onStarted,
		watchLifecycle: (
			id: Id<'threadRecords'>,
			onUpdate: (lifecycle: SelectedThreadLifecycle) => void,
			onError: (error: Error) => void
		) => {
			listeners.set(id, onUpdate);
			errors.set(id, onError);

			return () => {
				listeners.delete(id);
				errors.delete(id);
			};
		}
	};

	queue.setContext(context);

	async function update(
		phase: SelectedThreadLifecycle['phase'],
		run = 'original',
		thread = threadId()
	) {
		listeners.get(thread)?.({
			threadId: thread,
			phase,
			run: { runId: runId(run), startedAt: 1 }
		});
		await Promise.resolve();
	}

	return {
		queue,
		context,
		listeners,
		errors,
		runAgent,
		discardTranscriptAttachment,
		onStarted,
		update
	};
}

describe('MessageQueue', () => {
	it('sends FIFO after each run ends, preserving the queued model and attachments', async () => {
		const { queue, runAgent, update, onStarted } = fixture();
		// SAFETY: fixture ids are only compared as opaque document identifiers.
		const storageId = 'file-1' as Id<'_storage'>;
		const first = request('first', { storageIds: [storageId] });
		queue.enqueue(first, ['board.png']);
		queue.enqueue(request('second', { selectedModel: 'model-two' }), []);
		await update('running');
		expect(queue.getSnapshot().map((message) => message.id)).toEqual(['first', 'second']);
		await update('waiting_for_input');
		await update('cancellation_requested');
		expect(runAgent).not.toHaveBeenCalled();
		await update('completed');
		expect(runAgent).toHaveBeenCalledExactlyOnceWith(first);
		expect(onStarted).toHaveBeenCalledWith({
			runId: runId('run-first'),
			threadId: threadId()
		});
		await update('completed');
		expect(runAgent).toHaveBeenCalledOnce();
		await update('running', 'run-first');
		await update('completed', 'run-first');
		expect(runAgent.mock.calls.map(([args]) => args.prompt)).toEqual(['first', 'second']);
		expect(runAgent.mock.calls[1]?.[0].selectedModel).toBe('model-two');
		expect(queue.getSnapshot()).toEqual([]);
	});

	it('keeps only one launch in flight even if lifecycle updates repeat', async () => {
		const { queue, runAgent, update } = fixture();
		let resolveStart: (started: AgentRunStart) => void = () => {};

		runAgent.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveStart = resolve;
				})
		);
		queue.enqueue(request('first'), []);
		queue.enqueue(request('second'), []);
		await update('completed');
		await update('completed');
		expect(runAgent).toHaveBeenCalledOnce();
		expect(queue.getSnapshot()[0]?.status).toBe('sending');
		await update('completed', 'run-first');
		resolveStart({ runId: runId('run-first'), threadId: threadId() });
		await Promise.resolve();
		expect(runAgent).toHaveBeenCalledTimes(2);
	});

	it('pauses on a failed launch and retries the same submission and executor capability', async () => {
		const { queue, runAgent, update } = fixture();
		runAgent.mockRejectedValueOnce(new Error('Server disconnected'));
		queue.enqueue(request('first'), []);
		queue.enqueue(request('second'), []);
		await update('completed');
		expect(queue.getSnapshot()[0]).toMatchObject({
			status: 'failed',
			error: 'Server disconnected'
		});
		await update('completed');
		expect(runAgent).toHaveBeenCalledOnce();
		queue.retry('first');
		await Promise.resolve();
		expect(runAgent.mock.calls.map(([args]) => args.submissionId)).toEqual(['first', 'first']);
		expect(runAgent.mock.calls.map(([args]) => args.executionSecret)).toEqual([
			'secret-first',
			'secret-first'
		]);
		await update('completed', 'run-first');
		expect(runAgent.mock.calls[2]?.[0].submissionId).toBe('second');
	});

	it.each(['failed', 'cancelled'] as const)('dispatches after a run becomes %s', async (phase) => {
		const { queue, runAgent, update } = fixture();
		queue.enqueue(request('first'), []);
		await update(phase);
		expect(runAgent).toHaveBeenCalledOnce();
	});

	it('watches every queued thread independently of which thread is selected', async () => {
		const { queue, runAgent, update } = fixture();
		queue.enqueue(request('first'), []);
		queue.enqueue(request('other', { threadId: threadId('thread-2') }), []);
		await update('running');
		await update('completed', 'other-original', threadId('thread-2'));
		expect(runAgent.mock.calls.map(([args]) => args.submissionId)).toEqual(['other']);
		await update('completed');
		expect(runAgent.mock.calls.map(([args]) => args.submissionId)).toEqual(['other', 'first']);
	});

	it('suspends on sign-out and never sends a different user’s messages', async () => {
		const { queue, context, runAgent, update, listeners } = fixture();
		queue.enqueue(request('first'), []);
		queue.setContext(null);
		expect(listeners.size).toBe(0);
		queue.setContext({ ...context, userId: 'user-2' });
		expect(listeners.size).toBe(0);
		expect(runAgent).not.toHaveBeenCalled();
		queue.setContext(context);
		await update('completed');
		expect(runAgent).toHaveBeenCalledOnce();
	});

	it('removes queued attachments and stops watching an empty queue', async () => {
		const { queue, discardTranscriptAttachment, runAgent, listeners } = fixture();
		// SAFETY: fixture ids are only compared as opaque document identifiers.
		const storageId = 'file-1' as Id<'_storage'>;
		queue.enqueue(request('first', { storageIds: [storageId] }), ['board.png']);
		queue.remove('first');
		expect(discardTranscriptAttachment).toHaveBeenCalledExactlyOnceWith({
			userId: 'user-1',
			threadId: threadId(),
			storageId
		});
		expect(queue.getSnapshot()).toEqual([]);
		expect(listeners.size).toBe(0);
		expect(runAgent).not.toHaveBeenCalled();
	});

	it('retains messages when lifecycle queries fail and resumes after a fresh result', async () => {
		const { queue, errors, runAgent, update } = fixture();
		queue.enqueue(request('first'), []);
		errors.get(threadId())?.(new Error('Query unavailable'));
		queue.retry('first');
		expect(runAgent).not.toHaveBeenCalled();
		await update('completed');
		expect(runAgent).toHaveBeenCalledOnce();
	});

	it('uses a cached terminal lifecycle delivered immediately when subscribing', async () => {
		const { queue, context, runAgent } = fixture();
		const stop = vi.fn();
		queue.setContext({
			...context,
			watchLifecycle: (id, onUpdate) => {
				onUpdate({
					threadId: id,
					phase: 'completed',
					run: { runId: runId('original'), startedAt: 1 }
				});

				return stop;
			}
		});
		queue.enqueue(request('first'), []);
		await Promise.resolve();
		expect(runAgent).toHaveBeenCalledExactlyOnceWith(request('first'));
		expect(queue.getSnapshot()).toEqual([]);
		expect(stop).toHaveBeenCalledOnce();
	});

	it('keeps the launch observation guard when reconnecting the queue', async () => {
		const { queue, context, runAgent, update } = fixture();
		queue.enqueue(request('first'), []);
		queue.enqueue(request('second'), []);
		await update('completed');
		queue.setContext(null);
		queue.setContext(context);
		await update('completed');
		expect(runAgent).toHaveBeenCalledOnce();
		await update('completed', 'run-first');
		expect(runAgent).toHaveBeenCalledTimes(2);
	});

	it('ignores results from a removed subscription after the same thread is queued again', async () => {
		const { queue, listeners, runAgent, update } = fixture();
		queue.enqueue(request('first'), []);
		const staleUpdate = listeners.get(threadId());
		queue.remove('first');
		queue.enqueue(request('second'), []);
		staleUpdate?.({ threadId: threadId(), phase: 'completed', run: null });
		expect(runAgent).not.toHaveBeenCalled();
		await update('completed');
		expect(runAgent).toHaveBeenCalledExactlyOnceWith(request('second'));
	});
});
