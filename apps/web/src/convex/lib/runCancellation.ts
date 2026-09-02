import type { Id } from '@convex/_generated/dataModel';
import { v, type Infer } from 'convex/values';
import { isRunFinalStatus, type vRunFinalStatus, type vRunStatus } from '@convex/lib/validators';

export const CANCELLATION_FORCE_AFTER_MS = 10_000;

export const selectedThreadLifecyclePhases = [
	'idle',
	'queued',
	'running',
	'waiting_for_input',
	'cancellation_requested',
	'completed',
	'failed',
	'cancelled'
] as const;

export const vSelectedThreadLifecyclePhase = v.union(
	v.literal('idle'),
	v.literal('queued'),
	v.literal('running'),
	v.literal('waiting_for_input'),
	v.literal('cancellation_requested'),
	v.literal('completed'),
	v.literal('failed'),
	v.literal('cancelled')
);

export type SelectedThreadLifecyclePhase = Infer<typeof vSelectedThreadLifecyclePhase>;

export const vSelectedThreadLifecycleRun = v.object({
	runId: v.id('runs'),
	startedAt: v.number(),
	completedAt: v.optional(v.number()),
	lastError: v.optional(v.string()),
	executorFriendlyName: v.optional(v.string())
});

export const vSelectedThreadLifecycle = v.object({
	threadId: v.id('threadRecords'),
	phase: vSelectedThreadLifecyclePhase,
	run: v.union(vSelectedThreadLifecycleRun, v.null())
});

export type SelectedThreadLifecycle = Infer<typeof vSelectedThreadLifecycle>;

const inProgressPhases: ReadonlySet<SelectedThreadLifecyclePhase> = new Set([
	'queued',
	'running',
	'waiting_for_input',
	'cancellation_requested'
]);

export function isLifecycleInProgress(phase: SelectedThreadLifecyclePhase): boolean {
	return inProgressPhases.has(phase);
}

export function isRunCancellationOpen(run: {
	status: Infer<typeof vRunStatus>;
	cancellationRequestedAt?: number;
}): boolean {
	return run.cancellationRequestedAt !== undefined && !isRunFinalStatus(run.status);
}

export function resolveRequestedFinalizeStatus(
	run: {
		status: Infer<typeof vRunStatus>;
		cancellationRequestedAt?: number;
	},
	requested: Infer<typeof vRunFinalStatus>
): Infer<typeof vRunFinalStatus> {
	if (isRunFinalStatus(run.status)) {
		return run.status;
	}
	if (requested === 'completed') {
		return 'completed';
	}
	if (isRunCancellationOpen(run)) {
		return 'cancelled';
	}
	return requested;
}

export function selectedThreadLifecyclePhase(args: {
	run: {
		status: Infer<typeof vRunStatus>;
		cancellationRequestedAt?: number;
	} | null;
	waitingForInput: boolean;
}): SelectedThreadLifecyclePhase {
	const run = args.run;
	if (!run) {
		return 'idle';
	}
	if (isRunCancellationOpen(run)) {
		return 'cancellation_requested';
	}
	if (run.status === 'queued') {
		return 'queued';
	}
	if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
		return run.status;
	}
	if (args.waitingForInput) {
		return 'waiting_for_input';
	}
	return 'running';
}

export function projectSelectedThreadLifecycle(args: {
	threadId: Id<'threadRecords'>;
	run: {
		_id: Id<'runs'>;
		status: Infer<typeof vRunStatus>;
		startedAt: number;
		completedAt?: number;
		lastError?: string;
		cancellationRequestedAt?: number;
	} | null;
	waitingForInput: boolean;
	executorFriendlyName?: string;
}): SelectedThreadLifecycle {
	const phase = selectedThreadLifecyclePhase({
		run: args.run,
		waitingForInput: args.waitingForInput
	});
	if (!args.run) {
		return { threadId: args.threadId, phase, run: null };
	}
	const projected: Infer<typeof vSelectedThreadLifecycleRun> = {
		runId: args.run._id,
		startedAt: args.run.startedAt
	};
	if (args.run.completedAt !== undefined) {
		projected.completedAt = args.run.completedAt;
	}
	if (args.run.lastError !== undefined) {
		projected.lastError = args.run.lastError;
	}
	if (args.executorFriendlyName) {
		projected.executorFriendlyName = args.executorFriendlyName;
	}
	return { threadId: args.threadId, phase, run: projected };
}
