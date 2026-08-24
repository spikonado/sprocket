import type { Doc, Id } from '@convex/_generated/dataModel';

// Heartbeats write `projectConnections` rows, which no hot list subscription
// reads, so cadence is no longer expensive there. The TTL exceeds two
// throttle intervals so a skipped beat never flaps status; staleness is safe
// because nothing consumes executor status yet; revisit before surfacing a
// connection badge.
export const EXECUTOR_HEARTBEAT_TTL_MS = 300_000;
export const EXECUTOR_HEARTBEAT_WRITE_THROTTLE_MS = 90_000;

type ProjectConnectionDoc = Doc<'projectConnections'>;

// Pre-split rows carried liveness on the project itself. Read only until a
// projectConnections row exists; remove with the legacy project fields.
export function legacyConnectionFromProject(
	project: Pick<Doc<'projects'>, 'connectedClientId' | 'lastHeartbeatAt'>
): Pick<ProjectConnectionDoc, 'clientId' | 'lastHeartbeatAt'> | null {
	return project.connectedClientId && project.lastHeartbeatAt !== undefined
		? { clientId: project.connectedClientId, lastHeartbeatAt: project.lastHeartbeatAt }
		: null;
}

export function getEffectiveExecutorStatus(
	connection: Pick<ProjectConnectionDoc, 'lastHeartbeatAt'> | null | undefined,
	now: number
) {
	return connection && now - connection.lastHeartbeatAt <= EXECUTOR_HEARTBEAT_TTL_MS
		? ('connected' as const)
		: ('disconnected' as const);
}

export function getDetachedConnections(
	connections: ProjectConnectionDoc[],
	clientId: string,
	attachedProjectIds: Iterable<Id<'projects'>>
) {
	const attachedIds = new Set<string>(attachedProjectIds);
	return connections.filter(
		(connection) => connection.clientId === clientId && !attachedIds.has(connection.projectId)
	);
}

export function shouldRefreshProjectHeartbeat(
	connection: Pick<ProjectConnectionDoc, 'clientId' | 'lastHeartbeatAt'> | null | undefined,
	clientId: string,
	now: number
) {
	if (!connection) {
		return true;
	}

	if (connection.clientId !== clientId) {
		return true;
	}

	return now - connection.lastHeartbeatAt >= EXECUTOR_HEARTBEAT_WRITE_THROTTLE_MS;
}
