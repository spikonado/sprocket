import { describe, expect, it } from 'vitest';
import { cancelExecutorJobsForTerminalRun, executorFailureRunPatch } from '$convex/lib/runs';

describe('executor run state', () => {
	it('releases the active run after a recoverable tool failure', () => {
		expect(
			executorFailureRunPatch({
				runStatus: 'awaiting_executor',
				activeJobId: 'job-1',
				failedJobId: 'job-1'
			})
		).toEqual({ status: 'running', activeJobId: undefined });
		expect(
			executorFailureRunPatch({
				runStatus: 'failed',
				activeJobId: 'job-1',
				failedJobId: 'job-1'
			})
		).toBeUndefined();
	});

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
