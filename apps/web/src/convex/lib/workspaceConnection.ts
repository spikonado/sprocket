import type { Doc } from '@convex/_generated/dataModel';

export const EXECUTOR_HEARTBEAT_TTL_MS = 45_000;
export const EXECUTOR_HEARTBEAT_WRITE_THROTTLE_MS = 20_000;

type WorkspaceSessionDoc = Doc<'workspaceSessions'>;

export function isExecutorHeartbeatFresh(
	lastHeartbeatAt: number | undefined,
	now: number = Date.now()
) {
	return lastHeartbeatAt !== undefined && now - lastHeartbeatAt <= EXECUTOR_HEARTBEAT_TTL_MS;
}

export function isWorkspaceSessionEffectivelyConnected(
	workspaceSession: Pick<WorkspaceSessionDoc, 'connectedClientId' | 'lastHeartbeatAt'>,
	now: number = Date.now()
) {
	return Boolean(
		workspaceSession.connectedClientId &&
		isExecutorHeartbeatFresh(workspaceSession.lastHeartbeatAt, now)
	);
}

export function getEffectiveExecutorStatus(
	workspaceSession: Pick<WorkspaceSessionDoc, 'connectedClientId' | 'lastHeartbeatAt'>,
	now: number = Date.now()
) {
	return isWorkspaceSessionEffectivelyConnected(workspaceSession, now)
		? ('connected' as const)
		: ('disconnected' as const);
}

export function withEffectiveWorkspaceSessionState<T extends WorkspaceSessionDoc>(
	workspaceSession: T,
	now: number = Date.now()
) {
	return {
		...workspaceSession,
		executorStatus: getEffectiveExecutorStatus(workspaceSession, now)
	};
}

export function getDetachedWorkspaceSessionIdsForClient(
	workspaceSessions: WorkspaceSessionDoc[],
	clientId: string,
	attachedWorkspaceSessionIds: Iterable<string>
) {
	const attachedIds = new Set(attachedWorkspaceSessionIds);
	return workspaceSessions
		.filter(
			(workspaceSession) =>
				workspaceSession.connectedClientId === clientId && !attachedIds.has(workspaceSession._id)
		)
		.map((workspaceSession) => workspaceSession._id);
}

export function getAttachedWorkspaceSessionsForClient(
	workspaceSessions: WorkspaceSessionDoc[],
	clientId: string,
	now: number = Date.now()
) {
	return workspaceSessions.filter(
		(workspaceSession) =>
			workspaceSession.connectedClientId === clientId &&
			isWorkspaceSessionEffectivelyConnected(workspaceSession, now)
	);
}

export function canClientClaimWorkspaceSession(
	workspaceSession: Pick<WorkspaceSessionDoc, 'connectedClientId' | 'lastHeartbeatAt'>,
	clientId: string,
	now: number = Date.now()
) {
	return (
		workspaceSession.connectedClientId === clientId &&
		isWorkspaceSessionEffectivelyConnected(workspaceSession, now)
	);
}

export function shouldRefreshWorkspaceHeartbeat(
	workspaceSession: Pick<WorkspaceSessionDoc, 'connectedClientId' | 'lastHeartbeatAt'>,
	clientId: string,
	now: number = Date.now()
) {
	if (workspaceSession.connectedClientId !== clientId) {
		return true;
	}

	if (workspaceSession.lastHeartbeatAt === undefined) {
		return true;
	}

	return now - workspaceSession.lastHeartbeatAt >= EXECUTOR_HEARTBEAT_WRITE_THROTTLE_MS;
}
