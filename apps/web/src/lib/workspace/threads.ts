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

export function getWorkspaceThreadGroups(
	workspaceSessions: WorkspaceSession[],
	threads: ThreadSummary[]
) {
	const groups = new Map<string, WorkspaceThreadGroup>();

	for (const workspaceSession of workspaceSessions) {
		groups.set(workspaceSession._id, {
			key: workspaceSession._id,
			workspaceName: workspaceSession.workspaceName,
			workspacePath: workspaceSession.workspacePath,
			workspaceSessionId: workspaceSession._id,
			executorStatus: workspaceSession.executorStatus,
			lastSeenAt: workspaceSession.lastSeenAt,
			latestThreadAt: 0,
			activeThreadCount: 0,
			localWorkspaceAvailability: workspaceSession.localWorkspaceAvailability,
			localWorkspaceError: workspaceSession.localWorkspaceError,
			threads: []
		});
	}

	for (const thread of threads) {
		const existingGroup = groups.get(thread.workspaceSessionId);
		if (existingGroup) {
			existingGroup.threads.push(thread);
			existingGroup.latestThreadAt = Math.max(existingGroup.latestThreadAt, thread.lastMessageAt);
			continue;
		}

		groups.set(thread.workspaceSessionId, {
			key: thread.workspaceSessionId,
			workspaceName: thread.workspaceName,
			workspaceSessionId: thread.workspaceSessionId,
			executorStatus: null,
			lastSeenAt: 0,
			latestThreadAt: thread.lastMessageAt,
			activeThreadCount: 0,
			threads: [thread]
		});
	}

	return [...groups.values()]
		.map((group) => ({
			...group,
			activeThreadCount: countActiveThreads(group.threads),
			threads: [...group.threads].sort((left, right) => right.lastMessageAt - left.lastMessageAt)
		}))
		.sort((left, right) =>
			left.workspaceName.localeCompare(right.workspaceName, undefined, {
				sensitivity: 'base'
			})
		);
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
	currentWorkspaceSessionId: Id<'workspaceSessions'> | null;
	draftWorkspaceSessionId: Id<'workspaceSessions'> | null;
}) {
	const { threads, currentThreadId, currentWorkspaceSessionId, draftWorkspaceSessionId } = args;

	if (currentWorkspaceSessionId && draftWorkspaceSessionId === currentWorkspaceSessionId) {
		return null;
	}

	if (currentThreadId && threads.some((thread) => thread.threadId === currentThreadId)) {
		return currentThreadId;
	}

	return threads[0]?.threadId ?? null;
}
