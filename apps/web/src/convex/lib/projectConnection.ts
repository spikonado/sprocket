import type { Doc } from '@convex/_generated/dataModel';

// Heartbeats write and re-run `projects.listMine`, so cadence is expensive.
// The TTL exceeds two throttle intervals so a skipped beat never flaps
// status; it's safe to be this stale only because no UI consumes
// executorStatus yet — revisit before surfacing a connection badge.
export const EXECUTOR_HEARTBEAT_TTL_MS = 300_000;
export const EXECUTOR_HEARTBEAT_WRITE_THROTTLE_MS = 90_000;

type ProjectDoc = Doc<'projects'>;

function isExecutorHeartbeatFresh(lastHeartbeatAt: number | undefined, now: number = Date.now()) {
	return lastHeartbeatAt !== undefined && now - lastHeartbeatAt <= EXECUTOR_HEARTBEAT_TTL_MS;
}

function isProjectEffectivelyConnected(
	project: Pick<ProjectDoc, 'connectedClientId' | 'lastHeartbeatAt'>,
	now: number = Date.now()
) {
	return Boolean(
		project.connectedClientId && isExecutorHeartbeatFresh(project.lastHeartbeatAt, now)
	);
}

export function getEffectiveExecutorStatus(
	project: Pick<ProjectDoc, 'connectedClientId' | 'lastHeartbeatAt'>,
	now: number = Date.now()
) {
	return isProjectEffectivelyConnected(project, now)
		? ('connected' as const)
		: ('disconnected' as const);
}

export function withEffectiveProjectState<T extends ProjectDoc>(
	project: T,
	now: number = Date.now()
) {
	return {
		...project,
		executorStatus: getEffectiveExecutorStatus(project, now)
	};
}

export function getDetachedProjectIdsForClient(
	projects: ProjectDoc[],
	clientId: string,
	attachedProjectIds: Iterable<string>
) {
	const attachedIds = new Set(attachedProjectIds);
	return projects
		.filter((project) => project.connectedClientId === clientId && !attachedIds.has(project._id))
		.map((project) => project._id);
}

export function shouldRefreshProjectHeartbeat(
	project: Pick<ProjectDoc, 'connectedClientId' | 'lastHeartbeatAt'>,
	clientId: string,
	now: number = Date.now()
) {
	if (project.connectedClientId !== clientId) {
		return true;
	}

	if (project.lastHeartbeatAt === undefined) {
		return true;
	}

	return now - project.lastHeartbeatAt >= EXECUTOR_HEARTBEAT_WRITE_THROTTLE_MS;
}
