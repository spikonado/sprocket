import type { Infer } from 'convex/values';
import { isRunFinalStatus, type vExecutorJobStatus, type vRunStatus } from '@convex/lib/validators';

type ExecutorJobState = {
	status: Infer<typeof vExecutorJobStatus>;
	error?: string;
	completedAt?: number;
};

const STARTED_WORK_MAY_CONTINUE =
	'Only the wait for its result ended. Work it started, such as a command or subagent, may still be running, so check before assuming it stopped.';

export function runStartedAt(run: { _creationTime: number }): number {
	return Math.floor(run._creationTime);
}

export function assertThreadCanStartRun(status: Infer<typeof vRunStatus> | null | undefined) {
	if (!status || isRunFinalStatus(status)) {
		return;
	}

	throw new Error('Stop the current run or wait for it to finish before sending another message.');
}

export function isSettledExecutorJobStatus(
	status: Infer<typeof vExecutorJobStatus>
): status is 'completed' | 'failed' | 'cancelled' {
	return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export function cancelExecutorJobsForTerminalRun<T extends ExecutorJobState>(args: {
	jobs: readonly T[];
	runStatus: Infer<typeof vRunStatus>;
	lastError?: string;
	completedAt: number;
}): T[] {
	if (!isRunFinalStatus(args.runStatus)) {
		return [...args.jobs];
	}

	const reason =
		args.runStatus === 'cancelled'
			? 'The run was stopped before this tool call finished.'
			: args.runStatus === 'failed'
				? 'The run failed before this tool call finished.'
				: 'The run ended before this tool call finished.';

	const error = [reason, args.lastError, STARTED_WORK_MAY_CONTINUE].filter(Boolean).join(' ');

	return args.jobs.map((job) => {
		if (isSettledExecutorJobStatus(job.status)) {
			return job;
		}

		return {
			...job,
			status: 'cancelled',
			error,
			completedAt: args.completedAt
		};
	});
}
