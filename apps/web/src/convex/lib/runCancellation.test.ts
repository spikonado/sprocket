import { describe, expect, it } from 'vitest';
import type { Id } from '@convex/_generated/dataModel';
import {
	isLifecycleInProgress,
	isRunCancellationOpen,
	projectSelectedThreadLifecycle,
	resolveRequestedFinalizeStatus,
	selectedThreadLifecyclePhase
} from '@convex/lib/runCancellation';

function runId(value: string): Id<'runs'> {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return value as Id<'runs'>;
}

function threadId(value: string): Id<'threadRecords'> {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return value as Id<'threadRecords'>;
}

describe('selected thread lifecycle phase', () => {
	it('is idle when the thread has no run', () => {
		expect(selectedThreadLifecyclePhase({ run: null, waitingForInput: false })).toBe('idle');
	});

	it('projects cancellation over queued, running, and waiting work', () => {
		expect(
			selectedThreadLifecyclePhase({
				run: { status: 'queued', cancellationRequestedAt: 1 },
				waitingForInput: false
			})
		).toBe('cancellation_requested');
		expect(
			selectedThreadLifecyclePhase({
				run: { status: 'running', cancellationRequestedAt: 1 },
				waitingForInput: true
			})
		).toBe('cancellation_requested');
	});

	it('maps stored run status onto queued, waiting, running, and terminal phases', () => {
		expect(selectedThreadLifecyclePhase({ run: { status: 'queued' }, waitingForInput: false })).toBe(
			'queued'
		);
		expect(
			selectedThreadLifecyclePhase({
				run: { status: 'awaiting_executor' },
				waitingForInput: true
			})
		).toBe('waiting_for_input');
		expect(
			selectedThreadLifecyclePhase({
				run: { status: 'awaiting_executor' },
				waitingForInput: false
			})
		).toBe('running');
		expect(
			selectedThreadLifecyclePhase({ run: { status: 'completed' }, waitingForInput: true })
		).toBe('completed');
		expect(selectedThreadLifecyclePhase({ run: { status: 'failed' }, waitingForInput: false })).toBe(
			'failed'
		);
		expect(
			selectedThreadLifecyclePhase({ run: { status: 'cancelled' }, waitingForInput: false })
		).toBe('cancelled');
	});

	it('treats in-progress phases as launch-blocking', () => {
		expect(isLifecycleInProgress('idle')).toBe(false);
		expect(isLifecycleInProgress('completed')).toBe(false);
		expect(isLifecycleInProgress('queued')).toBe(true);
		expect(isLifecycleInProgress('waiting_for_input')).toBe(true);
		expect(isLifecycleInProgress('cancellation_requested')).toBe(true);
	});
});

describe('requested cancellation finalize mapping', () => {
	it('lets completed win before the force-cancel deadline', () => {
		expect(
			resolveRequestedFinalizeStatus(
				{ status: 'running', cancellationRequestedAt: 1 },
				'completed'
			)
		).toBe('completed');
	});

	it('maps executor failure during requested cancellation to cancelled', () => {
		expect(
			resolveRequestedFinalizeStatus({ status: 'running', cancellationRequestedAt: 1 }, 'failed')
		).toBe('cancelled');
	});

	it('keeps an already-terminal status', () => {
		expect(resolveRequestedFinalizeStatus({ status: 'completed' }, 'cancelled')).toBe('completed');
		expect(isRunCancellationOpen({ status: 'completed', cancellationRequestedAt: 1 })).toBe(false);
	});
});

describe('selected thread lifecycle projection', () => {
	it('exposes only run id, times, error, and executor name', () => {
		expect(
			projectSelectedThreadLifecycle({
				threadId: threadId('thread-1'),
				run: {
					_id: runId('run-1'),
					status: 'running',
					startedAt: 10,
					lastError: 'boom',
					cancellationRequestedAt: 11
				},
				waitingForInput: false,
				executorFriendlyName: 'Workshop'
			})
		).toEqual({
			threadId: 'thread-1',
			phase: 'cancellation_requested',
			run: {
				runId: 'run-1',
				startedAt: 10,
				lastError: 'boom',
				executorFriendlyName: 'Workshop'
			}
		});
	});
});
