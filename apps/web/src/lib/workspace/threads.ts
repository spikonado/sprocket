import type { Id } from '$convex/_generated/dataModel';
import type { ThreadSummary, WorkspaceSession, WorkspaceThreadGroup } from '$lib/types/sprocket';

export function getAttachedWorkspaceSessionIds(
	workspaceSessions: WorkspaceSession[],
	clientId: string | null
) {
	if (!clientId) {
		return [];
	}

	return workspaceSessions
		.filter(
			(workspaceSession) =>
				workspaceSession.connectedClientId === clientId &&
				workspaceSession.executorStatus === 'connected'
		)
		.map((workspaceSession) => workspaceSession._id);
}

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

export function countActiveThreads(threads: ThreadSummary[]) {
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

export function resolveWorkspaceThreadSelection(args: {
	threads: ThreadSummary[];
	currentThreadId: Id<'threadRecords'> | null;
	currentWorkspaceName: string | null;
	draftWorkspaceName: string | null;
}) {
	const { threads, currentThreadId, currentWorkspaceName, draftWorkspaceName } = args;

	if (currentWorkspaceName && draftWorkspaceName === currentWorkspaceName) {
		return null;
	}

	if (currentThreadId && threads.some((thread) => thread.threadId === currentThreadId)) {
		return currentThreadId;
	}

	return threads[0]?.threadId ?? null;
}
