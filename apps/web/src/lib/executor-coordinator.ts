import type { Id } from '$convex/_generated/dataModel';
import type {
	ExecutorJob,
	ThreadSummary,
	WorkspaceSession,
	WorkspaceThreadGroup
} from '$lib/types/sprocket';

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

export function getWorkspaceSessionLookup(workspaceSessions: WorkspaceSession[]) {
	return new Map(
		workspaceSessions.map((workspaceSession) => [workspaceSession._id, workspaceSession])
	);
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
			gitBranch: workspaceSession.gitBranch,
			gitDirty: workspaceSession.gitDirty,
			executorStatus: workspaceSession.executorStatus,
			lastSeenAt: workspaceSession.lastSeenAt,
			latestThreadAt: 0,
			activeThreadCount: 0,
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
			workspacePath: thread.workspacePath,
			workspaceSessionId: thread.workspaceSessionId,
			gitBranch: null,
			gitDirty: false,
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

export function groupExecutorJobsByWorkspace(executorJobs: ExecutorJob[]) {
	const jobsByWorkspace = new Map<Id<'workspaceSessions'>, ExecutorJob[]>();

	for (const executorJob of executorJobs) {
		const existing = jobsByWorkspace.get(executorJob.workspaceSessionId);
		if (existing) {
			existing.push(executorJob);
			continue;
		}

		jobsByWorkspace.set(executorJob.workspaceSessionId, [executorJob]);
	}

	return jobsByWorkspace;
}

export function pickNextExecutorJobForWorkspace(executorJobs: ExecutorJob[]) {
	return (
		executorJobs.find((executorJob) => executorJob.status === 'claimed') ??
		executorJobs.find((executorJob) => executorJob.status === 'pending') ??
		null
	);
}

export function countActiveThreads(threads: ThreadSummary[]) {
	return threads.filter((thread) => thread.hasActiveRun).length;
}
