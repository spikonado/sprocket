import { describe, expect, it } from 'vitest';
import {
	beginPendingAgentLaunch,
	clearPendingAgentLaunch,
	dataForThread,
	findWorkspaceSessionByName,
	getWorkspaceThreadGroups,
	isActiveThread,
	isAgentLaunchPending,
	isLatestRunReadyForThread,
	resolveExpiredAgentLaunch,
	resolvePendingAgentLaunch,
	resolvePendingAgentLaunchesFromThreads,
	resolvePendingCreatedThreadId,
	resolveWorkspaceThreadSelection,
	type PendingAgentLaunch,
	type PendingAgentLaunches
} from '$lib/workspace/threads';
import { defaultModelId, defaultReasoningEffort, defaultServiceTier } from '$convex/lib/models';
import type { ThreadSummary, WorkspaceSession } from '$lib/types/sprocket';

type RunId = NonNullable<ThreadSummary['latestRunId']>;

const threadA = 'thread-record-a' as ThreadSummary['threadId'];
const threadB = 'thread-record-b' as ThreadSummary['threadId'];
const runA1 = 'run-a-1' as RunId;
const runA2 = 'run-a-2' as RunId;
const runB1 = 'run-b-1' as RunId;
const runB2 = 'run-b-2' as RunId;

function makeWorkspaceSession(overrides: Partial<WorkspaceSession> = {}): WorkspaceSession {
	return {
		_id: (overrides._id ?? 'ws-1') as WorkspaceSession['_id'],
		userId: 'user-1',
		workspaceName: 'Workspace',
		executorStatus: 'disconnected',
		lastHeartbeatAt: undefined,
		connectedClientId: undefined,
		lastSeenAt: 0,
		...overrides
	};
}

function makeThreadSummary(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
	return {
		_id: (overrides._id ?? 'thread-record-1') as ThreadSummary['_id'],
		threadId: (overrides.threadId ??
			overrides._id ??
			'thread-record-1') as ThreadSummary['threadId'],
		workspaceSessionId: (overrides.workspaceSessionId ??
			'ws-1') as ThreadSummary['workspaceSessionId'],
		workspaceName: 'Workspace',
		title: 'Thread',
		selectedModel: overrides.selectedModel ?? defaultModelId,
		reasoningEffort: overrides.reasoningEffort ?? defaultReasoningEffort,
		serviceTier: overrides.serviceTier ?? defaultServiceTier,
		lastMessageAt: 0,
		threadStatus: 'active',
		latestRunStatus: null,
		latestRunId: null,
		latestRunStartedAt: undefined,
		latestRunClaimExpiresAt: undefined,
		hasActiveRun: false,
		...overrides
	};
}

function beginLaunch(
	pendingLaunches: PendingAgentLaunches,
	threadId: ThreadSummary['threadId'],
	launchId: number,
	previousRunId: RunId | null = null,
	extras: Partial<PendingAgentLaunch> = {}
): PendingAgentLaunches {
	return beginPendingAgentLaunch(pendingLaunches, threadId, {
		expiresAt: 100,
		launchId,
		previousRunId,
		...extras
	});
}

describe('workspace thread helpers', () => {
	it('groups threads by exact workspace name', () => {
		const groups = getWorkspaceThreadGroups(
			[
				makeWorkspaceSession({
					_id: 'ws-current' as WorkspaceSession['_id'],
					workspaceName: 'sprocket'
				})
			],
			[
				makeThreadSummary({
					workspaceSessionId: 'ws-current' as ThreadSummary['workspaceSessionId'],
					workspaceName: 'sprocket',
					lastMessageAt: 10
				}),
				makeThreadSummary({
					_id: 'thread-record-2' as ThreadSummary['_id'],
					threadId: 'thread-record-2' as ThreadSummary['threadId'],
					workspaceSessionId: 'ws-stale' as ThreadSummary['workspaceSessionId'],
					workspaceName: 'sprocket',
					lastMessageAt: 20
				}),
				makeThreadSummary({
					_id: 'thread-record-3' as ThreadSummary['_id'],
					threadId: 'thread-record-3' as ThreadSummary['threadId'],
					workspaceSessionId: 'ws-other' as ThreadSummary['workspaceSessionId'],
					workspaceName: 'Sprocket',
					lastMessageAt: 30
				})
			]
		);

		expect(groups).toHaveLength(2);
		expect(groups.find((group) => group.workspaceName === 'sprocket')?.threads).toHaveLength(2);
		expect(groups.find((group) => group.workspaceName === 'Sprocket')?.threads).toHaveLength(1);
	});

	it('excludes archived threads from project groups', () => {
		const active = makeThreadSummary({
			workspaceSessionId: 'ws-current' as ThreadSummary['workspaceSessionId'],
			workspaceName: 'sprocket',
			lastMessageAt: 10
		});
		const archived = makeThreadSummary({
			_id: 'thread-record-2' as ThreadSummary['_id'],
			threadId: 'thread-record-2' as ThreadSummary['threadId'],
			workspaceSessionId: 'ws-current' as ThreadSummary['workspaceSessionId'],
			workspaceName: 'sprocket',
			lastMessageAt: 20,
			threadStatus: 'archived'
		});

		expect(isActiveThread(active)).toBe(true);
		expect(isActiveThread(archived)).toBe(false);

		const groups = getWorkspaceThreadGroups(
			[
				makeWorkspaceSession({
					_id: 'ws-current' as WorkspaceSession['_id'],
					workspaceName: 'sprocket'
				})
			],
			[active, archived]
		);

		expect(groups).toHaveLength(1);
		expect(groups[0]?.threads).toHaveLength(1);
		expect(groups[0]?.threads[0]?.threadId).toBe('thread-record-1');
	});

	it('lists running threads before newer completed threads in each project', () => {
		const groups = getWorkspaceThreadGroups(
			[],
			[
				makeThreadSummary({
					_id: 'thread-record-completed-newer' as ThreadSummary['_id'],
					threadId: 'thread-record-completed-newer' as ThreadSummary['threadId'],
					lastMessageAt: 30
				}),
				makeThreadSummary({
					_id: 'thread-record-running-older' as ThreadSummary['_id'],
					threadId: 'thread-record-running-older' as ThreadSummary['threadId'],
					lastMessageAt: 10,
					hasActiveRun: true
				}),
				makeThreadSummary({
					_id: 'thread-record-running-newer' as ThreadSummary['_id'],
					threadId: 'thread-record-running-newer' as ThreadSummary['threadId'],
					lastMessageAt: 20,
					hasActiveRun: true
				})
			]
		);

		expect(groups[0]?.threads.map((thread) => thread.threadId)).toEqual([
			'thread-record-running-newer',
			'thread-record-running-older',
			'thread-record-completed-newer'
		]);
	});

	it('finds a workspace session by exact name', () => {
		const session = findWorkspaceSessionByName(
			[
				makeWorkspaceSession({
					_id: 'ws-1' as WorkspaceSession['_id'],
					workspaceName: 'Sprocket'
				})
			],
			'sprocket'
		);

		expect(session).toBeNull();
	});

	it('preserves a blank draft selection for the current workspace', () => {
		expect(
			resolveWorkspaceThreadSelection({
				threads: [makeThreadSummary()],
				currentThreadId: null,
				currentWorkspaceName: 'Workspace',
				draftWorkspaceName: 'Workspace'
			})
		).toBeNull();
	});

	it('preserves a newly created thread id before the reactive list includes it', () => {
		const existing = makeThreadSummary({
			_id: 'thread-record-old' as ThreadSummary['_id'],
			threadId: 'thread-record-old' as ThreadSummary['threadId'],
			lastMessageAt: 20
		});
		const pendingThreadId = 'thread-record-new' as ThreadSummary['threadId'];

		expect(
			resolveWorkspaceThreadSelection({
				threads: [existing],
				currentThreadId: pendingThreadId,
				currentWorkspaceName: 'Workspace',
				draftWorkspaceName: null,
				pendingCreatedThreadId: pendingThreadId
			})
		).toBe(pendingThreadId);
	});

	it('falls back when an established thread disappears from the list', () => {
		const newest = makeThreadSummary({
			_id: 'thread-record-newest' as ThreadSummary['_id'],
			threadId: 'thread-record-newest' as ThreadSummary['threadId'],
			lastMessageAt: 30
		});

		expect(
			resolveWorkspaceThreadSelection({
				threads: [newest],
				currentThreadId: 'thread-record-vanished' as ThreadSummary['threadId'],
				currentWorkspaceName: 'Workspace',
				draftWorkspaceName: null,
				pendingCreatedThreadId: null
			})
		).toBe(newest.threadId);
	});

	it('falls back to the newest thread only after the current id is cleared', () => {
		const newest = makeThreadSummary({
			_id: 'thread-record-newest' as ThreadSummary['_id'],
			threadId: 'thread-record-newest' as ThreadSummary['threadId'],
			lastMessageAt: 30
		});

		expect(
			resolveWorkspaceThreadSelection({
				threads: [newest],
				currentThreadId: null,
				currentWorkspaceName: 'Workspace',
				draftWorkspaceName: null
			})
		).toBe(newest.threadId);
	});

	it('keeps a created id pinned through unrelated list updates until the thread appears', () => {
		const existing = makeThreadSummary({
			_id: 'thread-record-old' as ThreadSummary['_id'],
			threadId: 'thread-record-old' as ThreadSummary['threadId']
		});
		const pendingThreadId = 'thread-record-new' as ThreadSummary['threadId'];
		const created = makeThreadSummary({
			_id: pendingThreadId,
			threadId: pendingThreadId
		});
		const unrelated = makeThreadSummary({
			_id: 'thread-record-unrelated' as ThreadSummary['_id'],
			threadId: 'thread-record-unrelated' as ThreadSummary['threadId'],
			lastMessageAt: 10
		});

		expect(
			resolvePendingCreatedThreadId({
				pendingCreatedThreadId: pendingThreadId,
				threads: [existing]
			})
		).toBe(pendingThreadId);
		expect(
			resolvePendingCreatedThreadId({
				pendingCreatedThreadId: pendingThreadId,
				threads: [unrelated, existing]
			})
		).toBe(pendingThreadId);
		expect(
			resolvePendingCreatedThreadId({
				pendingCreatedThreadId: pendingThreadId,
				threads: [created, existing]
			})
		).toBeNull();
	});

	it('tracks pending launches independently by thread and clears only progressed ones', () => {
		let pendingLaunches = beginLaunch({}, threadA, 1, runA1);
		pendingLaunches = beginLaunch(pendingLaunches, threadB, 2, runB1);

		expect(isAgentLaunchPending(pendingLaunches, threadA)).toBe(true);
		expect(isAgentLaunchPending(pendingLaunches, threadB)).toBe(true);
		expect(
			isAgentLaunchPending(resolvePendingAgentLaunch(pendingLaunches, threadA, runA1), threadA)
		).toBe(true);

		pendingLaunches = resolvePendingAgentLaunchesFromThreads(pendingLaunches, [
			makeThreadSummary({ threadId: threadA, latestRunId: runA1, latestRunStartedAt: 10 }),
			makeThreadSummary({ threadId: threadB, latestRunId: runB2, latestRunStartedAt: 10 })
		]);
		expect(isAgentLaunchPending(pendingLaunches, threadA)).toBe(true);
		expect(isAgentLaunchPending(pendingLaunches, threadB)).toBe(false);

		pendingLaunches = resolvePendingAgentLaunch(pendingLaunches, threadA, runA2);
		expect(isAgentLaunchPending(pendingLaunches, threadA)).toBe(false);
	});

	it('expires only the matching pending launch and recovers only when the run is unchanged', () => {
		let pendingLaunches = beginLaunch({}, threadA, 1);
		pendingLaunches = beginLaunch(pendingLaunches, threadB, 2);

		expect(resolveExpiredAgentLaunch(pendingLaunches, threadA, 1, 99, null)).toEqual({
			pendingLaunches,
			shouldRecover: false
		});
		expect(resolveExpiredAgentLaunch(pendingLaunches, threadA, 3, 100, null)).toEqual({
			pendingLaunches,
			shouldRecover: false
		});

		const expired = resolveExpiredAgentLaunch(pendingLaunches, threadA, 1, 100, null);
		expect(expired.shouldRecover).toBe(true);
		expect(isAgentLaunchPending(expired.pendingLaunches, threadA)).toBe(false);
		expect(isAgentLaunchPending(expired.pendingLaunches, threadB)).toBe(true);

		const visibleRun = resolveExpiredAgentLaunch(
			beginLaunch({}, threadA, 1, runA1),
			threadA,
			1,
			100,
			runA2
		);
		expect(isAgentLaunchPending(visibleRun.pendingLaunches, threadA)).toBe(false);
		expect(visibleRun.shouldRecover).toBe(false);
	});

	it('reconciles a retry when the existing run receives a new claim lease', () => {
		const pendingLaunches = beginLaunch({}, threadA, 1, runA1, {
			previousClaimExpiresAt: 50
		});

		expect(resolvePendingAgentLaunch(pendingLaunches, threadA, runA1, 50)).toBe(pendingLaunches);
		expect(
			isAgentLaunchPending(resolvePendingAgentLaunch(pendingLaunches, threadA, runA1, 150), threadA)
		).toBe(false);
	});

	it('waits for an established thread latest-run query but permits a newly created thread', () => {
		expect(
			isLatestRunReadyForThread({
				threadId: threadA,
				pendingCreatedThreadId: null,
				hasLatestRunData: false
			})
		).toBe(false);
		expect(
			isLatestRunReadyForThread({
				threadId: threadA,
				pendingCreatedThreadId: threadA,
				hasLatestRunData: false
			})
		).toBe(true);
		expect(
			isLatestRunReadyForThread({
				threadId: threadA,
				pendingCreatedThreadId: null,
				hasLatestRunData: true
			})
		).toBe(true);
	});

	it('scopes error cleanup to the matching thread and launch', () => {
		let pendingLaunches = beginLaunch({}, threadA, 1);
		pendingLaunches = beginLaunch(pendingLaunches, threadA, 2, runA1);
		pendingLaunches = beginLaunch(pendingLaunches, threadB, 3);

		expect(clearPendingAgentLaunch(pendingLaunches, threadA, 1)).toBe(pendingLaunches);

		const afterThreadAError = clearPendingAgentLaunch(pendingLaunches, threadA, 2);
		expect(isAgentLaunchPending(afterThreadAError, threadA)).toBe(false);
		expect(isAgentLaunchPending(afterThreadAError, threadB)).toBe(true);
	});

	it('rejects stale thread-scoped query data', () => {
		const thread = makeThreadSummary();
		const activeThreadRecord = {
			_id: thread.threadId,
			title: thread.title
		};

		expect(dataForThread(thread, thread.threadId)).toBe(thread);
		expect(dataForThread(activeThreadRecord, thread.threadId)).toBe(activeThreadRecord);
		expect(dataForThread(thread, 'thread-record-2' as ThreadSummary['threadId'])).toBeNull();
		expect(dataForThread(undefined, thread.threadId)).toBeNull();
	});
});
