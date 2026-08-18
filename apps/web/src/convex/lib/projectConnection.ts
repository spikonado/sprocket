import type { Doc, Id } from '@convex/_generated/dataModel';

// Heartbeats write `projectConnections` rows, which no hot list subscription
// reads, so cadence is no longer expensive there. The TTL exceeds two
// throttle intervals so a skipped beat never flaps status; staleness is safe
// because connection state only feeds the executor badge, not execution.
export const EXECUTOR_HEARTBEAT_TTL_MS = 300_000;
export const EXECUTOR_HEARTBEAT_WRITE_THROTTLE_MS = 90_000;

type ProjectConnectionDoc = Doc<'projectConnections'>;

function isExecutorHeartbeatFresh(lastHeartbeatAt: number | undefined, now: number = Date.now()) {
	return lastHeartbeatAt !== undefined && now - lastHeartbeatAt <= EXECUTOR_HEARTBEAT_TTL_MS;
}

function isConnectionLive(
	connection: Pick<ProjectConnectionDoc, 'clientId' | 'lastHeartbeatAt'> | null | undefined,
	now: number = Date.now()
) {
	return Boolean(connection?.clientId && isExecutorHeartbeatFresh(connection.lastHeartbeatAt, now));
}

export function getEffectiveExecutorStatus(
	connection: Pick<ProjectConnectionDoc, 'clientId' | 'lastHeartbeatAt'> | null | undefined,
	now: number = Date.now()
) {
	return isConnectionLive(connection, now) ? ('connected' as const) : ('disconnected' as const);
}

export function getDetachedConnectionProjectIds(
	connections: ProjectConnectionDoc[],
	clientId: string,
	attachedProjectIds: Iterable<Id<'projects'>>
) {
	const attachedIds = new Set<string>(attachedProjectIds);
	return connections
		.filter(
			(connection) => connection.clientId === clientId && !attachedIds.has(connection.projectId)
		)
		.map((connection) => connection.projectId);
}

export function shouldRefreshProjectHeartbeat(
	connection: Pick<ProjectConnectionDoc, 'clientId' | 'lastHeartbeatAt'> | null | undefined,
	clientId: string,
	now: number = Date.now()
) {
	if (!connection) {
		return true;
	}

	if (connection.clientId !== clientId) {
		return true;
	}

	return now - connection.lastHeartbeatAt >= EXECUTOR_HEARTBEAT_WRITE_THROTTLE_MS;
}
