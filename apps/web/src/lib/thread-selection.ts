import type { Id } from '$convex/_generated/dataModel';
import type { ThreadSummary } from '$lib/types/sprocket';

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
