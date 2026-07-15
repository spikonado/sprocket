import type { Id } from '$convex/_generated/dataModel';
import type { ThreadSummary, WorkspaceSession, WorkspaceThreadGroup } from '$lib/types/sprocket';

export function findWorkspaceSessionByName<T extends Pick<WorkspaceSession, 'workspaceName'>>(
	workspaceSessions: T[],
	workspaceName: string
): T | null {
	return workspaceSessions.find((session) => session.workspaceName === workspaceName) ?? null;
}

export function getWorkspaceThreadGroups(
	workspaceSessions: WorkspaceSession[],
	threads: ThreadSummary[]
) {
	const groups = new Map<string, WorkspaceThreadGroup>();

	for (const thread of threads) {
		const existingGroup = groups.get(thread.workspaceName);

		if (existingGroup) {
			existingGroup.threads.push(thread);
			existingGroup.latestThreadAt = Math.max(existingGroup.latestThreadAt, thread.lastMessageAt);
			continue;
		}

		groups.set(thread.workspaceName, {
			key: thread.workspaceName,
			workspaceName: thread.workspaceName,
			workspaceSessionId: thread.workspaceSessionId,
			executorStatus: null,
			lastSeenAt: 0,
			latestThreadAt: thread.lastMessageAt,
			activeThreadCount: 0,
			threads: [thread]
		});
	}

	for (const workspaceSession of workspaceSessions) {
		const existingGroup = groups.get(workspaceSession.workspaceName);

		if (existingGroup) {
			existingGroup.workspaceSessionId = workspaceSession._id;
			existingGroup.executorStatus = workspaceSession.executorStatus;
			existingGroup.lastSeenAt = workspaceSession.lastSeenAt;
			existingGroup.localWorkspaceAvailability = workspaceSession.localWorkspaceAvailability;
			existingGroup.localWorkspaceError = workspaceSession.localWorkspaceError;
			existingGroup.workspacePath = workspaceSession.workspacePath;
			continue;
		}

		groups.set(workspaceSession.workspaceName, {
			key: workspaceSession.workspaceName,
			workspaceName: workspaceSession.workspaceName,
			workspaceSessionId: workspaceSession._id,
			executorStatus: workspaceSession.executorStatus,
			lastSeenAt: workspaceSession.lastSeenAt,
			latestThreadAt: 0,
			activeThreadCount: 0,
			localWorkspaceAvailability: workspaceSession.localWorkspaceAvailability,
			localWorkspaceError: workspaceSession.localWorkspaceError,
			workspacePath: workspaceSession.workspacePath,
			threads: []
		});
	}

	return [...groups.values()]
		.map((group) => ({
			...group,
			activeThreadCount: countActiveThreads(group.threads),
			threads: [...group.threads].sort((left, right) => right.lastMessageAt - left.lastMessageAt)
		}))
		.sort((left, right) => {
			const leftSortKey = left.latestThreadAt || left.lastSeenAt;
			const rightSortKey = right.latestThreadAt || right.lastSeenAt;
			if (rightSortKey !== leftSortKey) {
				return rightSortKey - leftSortKey;
			}

			return left.workspaceName.localeCompare(right.workspaceName);
		});
}

function countActiveThreads(threads: ThreadSummary[]) {
	return threads.filter((thread) => thread.hasActiveRun).length;
}

export function findThreadById(
	threads: ThreadSummary[],
	threadId: Id<'threadRecords'> | null
): ThreadSummary | null {
	if (!threadId) {
		return null;
	}

	return threads.find((thread) => thread.threadId === threadId) ?? null;
}

export function dataForThread<
	T extends { threadId?: Id<'threadRecords'>; _id?: Id<'threadRecords'> }
>(data: T | null | undefined, threadId: Id<'threadRecords'> | null): T | null {
	return threadId && (data?.threadId ?? data?._id) === threadId ? data! : null;
}

export function resolvePendingCreatedThreadId(args: {
	pendingCreatedThreadId: Id<'threadRecords'> | null;
	threads: ThreadSummary[];
}): Id<'threadRecords'> | null {
	const { pendingCreatedThreadId, threads } = args;
	if (!pendingCreatedThreadId) {
		return null;
	}

	if (threads.some((thread) => thread.threadId === pendingCreatedThreadId)) {
		return null;
	}

	return pendingCreatedThreadId;
}

export function isLatestRunReadyForThread(args: {
	threadId: Id<'threadRecords'> | null;
	pendingCreatedThreadId: Id<'threadRecords'> | null;
	hasLatestRunData: boolean;
}): boolean {
	return !args.threadId || args.threadId === args.pendingCreatedThreadId || args.hasLatestRunData;
}

export type PendingAgentLaunch = {
	expiresAt: number;
	launchId: number;
	previousClaimExpiresAt?: number;
	previousRunId: Id<'runs'> | null;
};

export type PendingAgentLaunches = Readonly<Partial<Record<string, PendingAgentLaunch>>>;

export function isAgentLaunchPending(
	pendingLaunches: PendingAgentLaunches,
	threadId: Id<'threadRecords'> | null
): boolean {
	return Boolean(threadId && pendingLaunches[threadId]);
}

export function beginPendingAgentLaunch(
	pendingLaunches: PendingAgentLaunches,
	threadId: Id<'threadRecords'>,
	launch: PendingAgentLaunch
): PendingAgentLaunches {
	return { ...pendingLaunches, [threadId]: launch };
}

export function clearPendingAgentLaunch(
	pendingLaunches: PendingAgentLaunches,
	threadId: Id<'threadRecords'>,
	launchId?: number
): PendingAgentLaunches {
	const pendingLaunch = pendingLaunches[threadId];
	if (!pendingLaunch || (launchId !== undefined && pendingLaunch.launchId !== launchId)) {
		return pendingLaunches;
	}

	const nextPendingLaunches = { ...pendingLaunches };
	delete nextPendingLaunches[threadId];
	return nextPendingLaunches;
}

function hasAgentLaunchProgressed(
	pendingLaunch: PendingAgentLaunch,
	observedRunId: Id<'runs'> | null,
	observedClaimExpiresAt?: number
): boolean {
	return Boolean(
		observedRunId &&
		(observedRunId !== pendingLaunch.previousRunId ||
			observedClaimExpiresAt !== pendingLaunch.previousClaimExpiresAt)
	);
}

export function resolvePendingAgentLaunch(
	pendingLaunches: PendingAgentLaunches,
	threadId: Id<'threadRecords'>,
	observedRunId: Id<'runs'> | null,
	observedClaimExpiresAt?: number
): PendingAgentLaunches {
	const pendingLaunch = pendingLaunches[threadId];
	if (
		!pendingLaunch ||
		!hasAgentLaunchProgressed(pendingLaunch, observedRunId, observedClaimExpiresAt)
	) {
		return pendingLaunches;
	}

	return clearPendingAgentLaunch(pendingLaunches, threadId, pendingLaunch.launchId);
}

export function resolvePendingAgentLaunchesFromThreads(
	pendingLaunches: PendingAgentLaunches,
	threads: ThreadSummary[]
): PendingAgentLaunches {
	let nextPendingLaunches = pendingLaunches;

	for (const thread of threads) {
		nextPendingLaunches = resolvePendingAgentLaunch(
			nextPendingLaunches,
			thread.threadId,
			thread.latestRunId,
			thread.latestRunClaimExpiresAt
		);
	}

	return nextPendingLaunches;
}

export function resolveExpiredAgentLaunch(
	pendingLaunches: PendingAgentLaunches,
	threadId: Id<'threadRecords'>,
	launchId: number,
	now: number,
	latestRunId: Id<'runs'> | null,
	latestClaimExpiresAt?: number
): { pendingLaunches: PendingAgentLaunches; shouldRecover: boolean } {
	const pendingLaunch = pendingLaunches[threadId];
	if (!pendingLaunch || pendingLaunch.launchId !== launchId || pendingLaunch.expiresAt > now) {
		return { pendingLaunches, shouldRecover: false };
	}

	return {
		pendingLaunches: clearPendingAgentLaunch(pendingLaunches, threadId, launchId),
		shouldRecover: !hasAgentLaunchProgressed(pendingLaunch, latestRunId, latestClaimExpiresAt)
	};
}

export function getThreadDeletionBlockMessage(
	pendingLaunches: PendingAgentLaunches,
	thread: Pick<ThreadSummary, 'threadId' | 'hasActiveRun'>
): string | null {
	if (isAgentLaunchPending(pendingLaunches, thread.threadId)) {
		return 'Wait for the local agent to start before deleting this thread.';
	}

	return thread.hasActiveRun
		? 'Finish or cancel the active run before deleting this thread.'
		: null;
}

export function resolveWorkspaceThreadSelection(args: {
	threads: ThreadSummary[];
	currentThreadId: Id<'threadRecords'> | null;
	currentWorkspaceName: string | null;
	draftWorkspaceName: string | null;
	pendingCreatedThreadId?: Id<'threadRecords'> | null;
}) {
	const {
		threads,
		currentThreadId,
		currentWorkspaceName,
		draftWorkspaceName,
		pendingCreatedThreadId = null
	} = args;

	if (currentWorkspaceName && draftWorkspaceName === currentWorkspaceName) {
		return null;
	}

	if (currentThreadId) {
		if (threads.some((thread) => thread.threadId === currentThreadId)) {
			return currentThreadId;
		}

		// Preserve an unknown ID only during the create → list catch-up window.
		if (pendingCreatedThreadId && currentThreadId === pendingCreatedThreadId) {
			return currentThreadId;
		}
	}

	return threads[0]?.threadId ?? null;
}
