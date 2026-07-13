import type { Infer } from 'convex/values';
import { isRunFinalStatus, type vExecutorJobStatus, type vRunStatus } from '@convex/lib/validators';

type ExecutorJobState = {
	status: Infer<typeof vExecutorJobStatus>;
	error?: string;
	completedAt?: number;
};

type FinalizedExecutorJob<T extends ExecutorJobState> = Omit<T, keyof ExecutorJobState> &
	ExecutorJobState;

export function assertThreadCanStartRun(status: Infer<typeof vRunStatus> | null | undefined) {
	if (!status || isRunFinalStatus(status)) {
		return;
	}

	throw new Error('Finish or cancel the active run before sending another message.');
}

export function executorFailureRunPatch(args: {
	runStatus: Infer<typeof vRunStatus>;
	activeJobId?: string;
	failedJobId: string;
}): { status: 'running'; activeJobId: undefined } | undefined {
	if (isRunFinalStatus(args.runStatus) || args.activeJobId !== args.failedJobId) {
		return undefined;
	}
	return {
		status: 'running',
		activeJobId: undefined
	};
}

export function cancelExecutorJobsForTerminalRun<T extends ExecutorJobState>(args: {
	jobs: readonly T[];
	runStatus: Infer<typeof vRunStatus>;
	lastError?: string;
	completedAt: number;
}): FinalizedExecutorJob<T>[] {
	if (!isRunFinalStatus(args.runStatus)) {
		return args.jobs.map((job) => job as FinalizedExecutorJob<T>);
	}
	const error =
		args.lastError ??
		(args.runStatus === 'cancelled'
			? 'Run was cancelled before executor job completed.'
			: args.runStatus === 'failed'
				? 'Run failed before executor job completed.'
				: 'Run completed before executor job completed.');
	return args.jobs.map((job) => {
		if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
			return job as FinalizedExecutorJob<T>;
		}
		return {
			...job,
			status: 'cancelled',
			error,
			completedAt: args.completedAt
		} as FinalizedExecutorJob<T>;
	});
}
