import { describe, expect, it } from 'vitest';
import type { Id } from '@convex/_generated/dataModel';
import {
	EXECUTOR_HEARTBEAT_WRITE_THROTTLE_MS,
	EXECUTOR_HEARTBEAT_TTL_MS,
	getDetachedConnections,
	getEffectiveExecutorStatus,
	shouldRefreshProjectHeartbeat
} from '@convex/lib/projectConnection';

function asProjectId(value: string): Id<'projects'> {
	// SAFETY: test fixtures use string ids; helpers only compare identity.
	return value as Id<'projects'>;
}

function asConnectionId(value: string): Id<'projectConnections'> {
	// SAFETY: test fixtures use string ids; helpers only compare identity.
	return value as Id<'projectConnections'>;
}

function makeConnection(
	overrides: Partial<{
		projectId: Id<'projects'>;
		clientId: string;
		lastHeartbeatAt: number;
	}> = {}
) {
	return {
		_id: asConnectionId('conn-1'),
		_creationTime: 0,
		projectId: overrides.projectId ?? asProjectId('project-1'),
		userId: 'user-1',
		clientId: overrides.clientId ?? 'client-1',
		lastHeartbeatAt: overrides.lastHeartbeatAt ?? 0
	};
}

describe('projectConnection helpers', () => {
	it('reports disconnected when the heartbeat is stale', () => {
		const now = 100_000;
		const connection = makeConnection({
			clientId: 'client-1',
			lastHeartbeatAt: now - EXECUTOR_HEARTBEAT_TTL_MS - 1
		});

		expect(getEffectiveExecutorStatus(connection, now)).toBe('disconnected');
	});

	it('reports disconnected when there is no connection row', () => {
		expect(getEffectiveExecutorStatus(null, 100_000)).toBe('disconnected');
	});

	it('returns omitted connections to detach for the same client', () => {
		const detached = getDetachedConnections(
			[
				makeConnection({
					projectId: asProjectId('project-1'),
					clientId: 'client-1'
				}),
				makeConnection({
					projectId: asProjectId('project-2'),
					clientId: 'client-1'
				}),
				makeConnection({
					projectId: asProjectId('project-3'),
					clientId: 'client-2'
				})
			],
			'client-1',
			[asProjectId('project-2')]
		);

		expect(detached.map((connection) => connection.projectId)).toEqual(['project-1']);
	});

	it('skips redundant heartbeat writes for the same client until the throttle elapses', () => {
		const now = 100_000;
		const connection = makeConnection({
			clientId: 'client-1',
			lastHeartbeatAt: now - EXECUTOR_HEARTBEAT_WRITE_THROTTLE_MS + 1
		});

		expect(shouldRefreshProjectHeartbeat(connection, 'client-1', now)).toBe(false);
		expect(
			shouldRefreshProjectHeartbeat(
				{
					...connection,
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
				makeConnection({
					clientId: 'client-2',
					lastHeartbeatAt: now
				}),
				'client-1',
				now
			)
		).toBe(true);
		expect(shouldRefreshProjectHeartbeat(null, 'client-1', now)).toBe(true);
	});
});
