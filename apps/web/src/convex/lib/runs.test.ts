import { describe, expect, it } from 'vitest';
import { assertThreadCanStartRun, cancelExecutorJobsForTerminalRun } from '@convex/lib/runs';

describe('assertThreadCanStartRun', () => {
	it('allows a thread with no prior run', () => {
		expect(() => assertThreadCanStartRun(null)).not.toThrow();
	});

	it('allows a thread whose latest run is final', () => {
		expect(() => assertThreadCanStartRun('completed')).not.toThrow();
		expect(() => assertThreadCanStartRun('failed')).not.toThrow();
		expect(() => assertThreadCanStartRun('cancelled')).not.toThrow();
	});

	it('rejects a thread with an active run', () => {
		expect(() => assertThreadCanStartRun('queued')).toThrow(
			'Finish or cancel the active run before sending another message.'
		);
		expect(() => assertThreadCanStartRun('running')).toThrow(
			'Finish or cancel the active run before sending another message.'
		);
		expect(() => assertThreadCanStartRun('awaiting_executor')).toThrow(
			'Finish or cancel the active run before sending another message.'
		);
	});
});

describe('cancelExecutorJobsForTerminalRun', () => {
	it('cancels every live sibling while preserving terminal jobs', () => {
		const completedAt = 42;
		const jobs = cancelExecutorJobsForTerminalRun({
			jobs: [
				{ id: 'pending', status: 'pending' as const },
				{ id: 'claimed', status: 'claimed' as const },
				{ id: 'completed', status: 'completed' as const, completedAt: 10 },
				{ id: 'failed', status: 'failed' as const, error: 'tool failed', completedAt: 11 }
			],
			runStatus: 'cancelled',
			lastError: 'stopped by user',
			completedAt
		});

		expect(jobs).toEqual([
			{ id: 'pending', status: 'cancelled', error: 'stopped by user', completedAt },
			{ id: 'claimed', status: 'cancelled', error: 'stopped by user', completedAt },
			{ id: 'completed', status: 'completed', completedAt: 10 },
			{ id: 'failed', status: 'failed', error: 'tool failed', completedAt: 11 }
		]);
	});

	it('cancels live siblings when a run completes', () => {
		const completedAt = 42;
		expect(
			cancelExecutorJobsForTerminalRun({
				jobs: [
					{ id: 'pending', status: 'pending' as const },
					{ id: 'claimed', status: 'claimed' as const },
					{ id: 'completed', status: 'completed' as const, completedAt: 10 },
					{ id: 'cancelled', status: 'cancelled' as const, error: 'already stopped' }
				],
				runStatus: 'completed',
				completedAt
			})
		).toEqual([
			{
				id: 'pending',
				status: 'cancelled',
				error: 'Run completed before executor job completed.',
				completedAt
			},
			{
				id: 'claimed',
				status: 'cancelled',
				error: 'Run completed before executor job completed.',
				completedAt
			},
			{ id: 'completed', status: 'completed', completedAt: 10 },
			{ id: 'cancelled', status: 'cancelled', error: 'already stopped' }
		]);
	});
});
