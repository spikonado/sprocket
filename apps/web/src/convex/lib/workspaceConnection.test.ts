import { describe, expect, it } from 'vitest';
import type { Id } from '@convex/_generated/dataModel';
import {
	EXECUTOR_HEARTBEAT_WRITE_THROTTLE_MS,
	EXECUTOR_HEARTBEAT_TTL_MS,
	getDetachedWorkspaceSessionIdsForClient,
	getEffectiveExecutorStatus,
	shouldRefreshWorkspaceHeartbeat
} from '@convex/lib/workspaceConnection';

function makeWorkspaceSession(
	overrides: Partial<{
		_id: Id<'workspaceSessions'>;
		connectedClientId?: string;
		lastHeartbeatAt?: number;
	}> = {}
) {
	return {
		_id: overrides._id ?? ('ws-1' as Id<'workspaceSessions'>),
		_creationTime: 0,
		userId: 'user-1',
		workspaceName: 'Workspace',
		lastHeartbeatAt: overrides.lastHeartbeatAt,
		connectedClientId: overrides.connectedClientId,
		nextExecutorSequence: 0,
		lastSeenAt: 0
	};
}

describe('workspaceConnection helpers', () => {
	it('reports disconnected when the heartbeat is stale', () => {
		const now = 100_000;
		const workspaceSession = makeWorkspaceSession({
			connectedClientId: 'client-1',
			lastHeartbeatAt: now - EXECUTOR_HEARTBEAT_TTL_MS - 1
		});

		expect(getEffectiveExecutorStatus(workspaceSession, now)).toBe('disconnected');
	});

	it('returns omitted sessions to detach for the same client', () => {
		const detached = getDetachedWorkspaceSessionIdsForClient(
			[
				makeWorkspaceSession({
					_id: 'ws-1' as Id<'workspaceSessions'>,
					connectedClientId: 'client-1'
				}),
				makeWorkspaceSession({
					_id: 'ws-2' as Id<'workspaceSessions'>,
					connectedClientId: 'client-1'
				}),
				makeWorkspaceSession({
					_id: 'ws-3' as Id<'workspaceSessions'>,
					connectedClientId: 'client-2'
				})
			],
			'client-1',
			['ws-2' as Id<'workspaceSessions'>]
		);

		expect(detached).toEqual(['ws-1']);
	});

	it('skips redundant heartbeat writes for the same client until the throttle elapses', () => {
		const now = 100_000;
		const workspaceSession = makeWorkspaceSession({
			connectedClientId: 'client-1',
			lastHeartbeatAt: now - EXECUTOR_HEARTBEAT_WRITE_THROTTLE_MS + 1
		});

		expect(shouldRefreshWorkspaceHeartbeat(workspaceSession, 'client-1', now)).toBe(false);
		expect(
			shouldRefreshWorkspaceHeartbeat(
				{
					...workspaceSession,
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
			shouldRefreshWorkspaceHeartbeat(
				makeWorkspaceSession({
					connectedClientId: 'client-2',
					lastHeartbeatAt: now
				}),
				'client-1',
				now
			)
		).toBe(true);
		expect(
			shouldRefreshWorkspaceHeartbeat(
				makeWorkspaceSession({
					connectedClientId: 'client-1',
					lastHeartbeatAt: undefined
				}),
				'client-1',
				now
			)
		).toBe(true);
	});
});
