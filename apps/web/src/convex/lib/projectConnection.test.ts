import { describe, expect, it } from 'vitest';
import type { Id } from '@convex/_generated/dataModel';
import {
	EXECUTOR_HEARTBEAT_WRITE_THROTTLE_MS,
	EXECUTOR_HEARTBEAT_TTL_MS,
	getDetachedProjectIdsForClient,
	getEffectiveExecutorStatus,
	shouldRefreshProjectHeartbeat
} from '@convex/lib/projectConnection';

function makeProject(
	overrides: Partial<{
		_id: Id<'projects'>;
		connectedClientId?: string;
		lastHeartbeatAt?: number;
	}> = {}
) {
	return {
		_id: overrides._id ?? ('project-1' as Id<'projects'>),
		_creationTime: 0,
		userId: 'user-1',
		repositoryKey: 'Workspace',
		displayName: 'Workspace',
		lastHeartbeatAt: overrides.lastHeartbeatAt,
		connectedClientId: overrides.connectedClientId,
		nextExecutorSequence: 0,
		lastSeenAt: 0
	};
}

describe('projectConnection helpers', () => {
	it('reports disconnected when the heartbeat is stale', () => {
		const now = 100_000;
		const project = makeProject({
			connectedClientId: 'client-1',
			lastHeartbeatAt: now - EXECUTOR_HEARTBEAT_TTL_MS - 1
		});

		expect(getEffectiveExecutorStatus(project, now)).toBe('disconnected');
	});

	it('returns omitted projects to detach for the same client', () => {
		const detached = getDetachedProjectIdsForClient(
			[
				makeProject({
					_id: 'project-1' as Id<'projects'>,
					connectedClientId: 'client-1'
				}),
				makeProject({
					_id: 'project-2' as Id<'projects'>,
					connectedClientId: 'client-1'
				}),
				makeProject({
					_id: 'project-3' as Id<'projects'>,
					connectedClientId: 'client-2'
				})
			],
			'client-1',
			['project-2' as Id<'projects'>]
		);

		expect(detached).toEqual(['project-1']);
	});

	it('skips redundant heartbeat writes for the same client until the throttle elapses', () => {
		const now = 100_000;
		const project = makeProject({
			connectedClientId: 'client-1',
			lastHeartbeatAt: now - EXECUTOR_HEARTBEAT_WRITE_THROTTLE_MS + 1
		});

		expect(shouldRefreshProjectHeartbeat(project, 'client-1', now)).toBe(false);
		expect(
			shouldRefreshProjectHeartbeat(
				{
					...project,
					lastHeartbeatAt: now - EXECUTOR_HEARTBEAT_WRITE_THROTTLE_MS
				},
				'client-1',
				now
			)
		).toBe(true);
	});

	it('always refreshes the heartbeat when ownership changes or no heartbeat exists yet', () => {
		const now = 100_000;

		expect(
			shouldRefreshProjectHeartbeat(
				makeProject({
					connectedClientId: 'client-2',
					lastHeartbeatAt: now
				}),
				'client-1',
				now
			)
		).toBe(true);
		expect(
			shouldRefreshProjectHeartbeat(
				makeProject({
					connectedClientId: 'client-1',
					lastHeartbeatAt: undefined
				}),
				'client-1',
				now
			)
		).toBe(true);
	});
});
