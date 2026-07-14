import { describe, expect, it } from 'vitest';
import {
	beginPendingAgentLaunch,
	clearPendingAgentLaunch,
	dataForThread,
	findWorkspaceSessionByName,
	getAttachedWorkspaceSessionIds,
	getWorkspaceThreadGroups,
	isAgentLaunchPending,
	isLatestRunReadyForThread,
	isSelectionGenerationCurrent,
	resolveExpiredAgentLaunch,
	resolvePendingAgentLaunch,
	resolvePendingAgentLaunchesFromThreads,
	resolvePendingCreatedThreadId,
	resolveWorkspaceThreadSelection
} from '$lib/workspace/threads';
import { defaultModelId, defaultReasoningEffort } from '$convex/lib/models';
import type { ThreadSummary, WorkspaceSession } from '$lib/types/sprocket';

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

describe('workspace thread helpers', () => {
	it('returns attached workspaces for the current executor client only', () => {
		const attached = getAttachedWorkspaceSessionIds(
			[
				makeWorkspaceSession({
					_id: 'ws-1' as WorkspaceSession['_id'],
					connectedClientId: 'client-1',
					executorStatus: 'connected'
				}),
				makeWorkspaceSession({
					_id: 'ws-2' as WorkspaceSession['_id'],
					connectedClientId: 'client-1',
					executorStatus: 'disconnected'
				}),
				makeWorkspaceSession({
					_id: 'ws-3' as WorkspaceSession['_id'],
					connectedClientId: 'client-2',
					executorStatus: 'connected'
				})
			],
			'client-1'
		);

		expect(attached).toEqual(['ws-1']);
	});

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
		const threads = [makeThreadSummary()];

		expect(
			resolveWorkspaceThreadSelection({
				threads,
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
		const vanished = 'thread-record-vanished' as ThreadSummary['threadId'];

		expect(
			resolveWorkspaceThreadSelection({
				threads: [newest],
				currentThreadId: vanished,
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

	it('tracks pending launches independently by thread', () => {
		const threadA = 'thread-record-a' as ThreadSummary['threadId'];
		const threadB = 'thread-record-b' as ThreadSummary['threadId'];
		const previousRunA = 'run-a-1' as never;
		const previousRunB = 'run-b-1' as never;
		let pendingLaunches = beginPendingAgentLaunch({}, threadA, {
			expiresAt: 100,
			launchId: 1,
			previousRunId: previousRunA
		});
		pendingLaunches = beginPendingAgentLaunch(pendingLaunches, threadB, {
			expiresAt: 100,
			launchId: 2,
			previousRunId: previousRunB
		});

		expect(isAgentLaunchPending(pendingLaunches, threadA)).toBe(true);
		expect(isAgentLaunchPending(pendingLaunches, threadB)).toBe(true);

		pendingLaunches = resolvePendingAgentLaunch(pendingLaunches, threadA, previousRunA);
		expect(isAgentLaunchPending(pendingLaunches, threadA)).toBe(true);

		pendingLaunches = resolvePendingAgentLaunch(pendingLaunches, threadA, 'run-a-2' as never);
		expect(isAgentLaunchPending(pendingLaunches, threadA)).toBe(false);
		expect(isAgentLaunchPending(pendingLaunches, threadB)).toBe(true);
	});

	it('expires only the matching pending launch after its deadline', () => {
		const threadA = 'thread-record-a' as ThreadSummary['threadId'];
		const threadB = 'thread-record-b' as ThreadSummary['threadId'];
		let pendingLaunches = beginPendingAgentLaunch({}, threadA, {
			expiresAt: 100,
			launchId: 1,
			previousRunId: null
		});
		pendingLaunches = beginPendingAgentLaunch(pendingLaunches, threadB, {
			expiresAt: 100,
			launchId: 2,
			previousRunId: null
		});

		expect(resolveExpiredAgentLaunch(pendingLaunches, threadA, 1, 99, null)).toEqual({
			pendingLaunches,
			shouldRecover: false
		});
		expect(resolveExpiredAgentLaunch(pendingLaunches, threadA, 3, 100, null)).toEqual({
			pendingLaunches,
			shouldRecover: false
		});

		const expired = resolveExpiredAgentLaunch(pendingLaunches, threadA, 1, 100, null);
		pendingLaunches = expired.pendingLaunches;
		expect(expired.shouldRecover).toBe(true);
		expect(isAgentLaunchPending(pendingLaunches, threadA)).toBe(false);
		expect(isAgentLaunchPending(pendingLaunches, threadB)).toBe(true);
	});

	it('does not recover an expired launch after its run becomes visible', () => {
		const threadId = 'thread-record-a' as ThreadSummary['threadId'];
		const previousRunId = 'run-a-1' as never;
		const pendingLaunches = beginPendingAgentLaunch({}, threadId, {
			expiresAt: 100,
			launchId: 1,
			previousRunId
		});

		const result = resolveExpiredAgentLaunch(pendingLaunches, threadId, 1, 100, 'run-a-2' as never);

		expect(isAgentLaunchPending(result.pendingLaunches, threadId)).toBe(false);
		expect(result.shouldRecover).toBe(false);
	});

	it('reconciles a retry when the existing run receives a new claim lease', () => {
		const threadId = 'thread-record-a' as ThreadSummary['threadId'];
		const runId = 'run-a-1' as never;
		const pendingLaunches = beginPendingAgentLaunch({}, threadId, {
			expiresAt: 100,
			launchId: 1,
			previousClaimExpiresAt: 50,
			previousRunId: runId
		});

		expect(resolvePendingAgentLaunch(pendingLaunches, threadId, runId, 50)).toBe(pendingLaunches);
		expect(
			isAgentLaunchPending(
				resolvePendingAgentLaunch(pendingLaunches, threadId, runId, 150),
				threadId
			)
		).toBe(false);
	});

	it('reconciles background launches by run id even when timestamps collide', () => {
		const threadA = 'thread-record-a' as ThreadSummary['threadId'];
		const threadB = 'thread-record-b' as ThreadSummary['threadId'];
		const previousRunA = 'run-a-1' as never;
		const previousRunB = 'run-b-1' as never;
		let pendingLaunches = beginPendingAgentLaunch({}, threadA, {
			expiresAt: 100,
			launchId: 1,
			previousRunId: previousRunA
		});
		pendingLaunches = beginPendingAgentLaunch(pendingLaunches, threadB, {
			expiresAt: 100,
			launchId: 2,
			previousRunId: previousRunB
		});

		pendingLaunches = resolvePendingAgentLaunchesFromThreads(pendingLaunches, [
			makeThreadSummary({
				threadId: threadA,
				latestRunId: previousRunA,
				latestRunStartedAt: 10
			}),
			makeThreadSummary({
				threadId: threadB,
				latestRunId: 'run-b-2' as never,
				latestRunStartedAt: 10
			})
		]);

		expect(isAgentLaunchPending(pendingLaunches, threadA)).toBe(true);
		expect(isAgentLaunchPending(pendingLaunches, threadB)).toBe(false);
	});

	it('waits for an established thread latest-run query but permits a newly created thread', () => {
		const threadId = 'thread-record-a' as ThreadSummary['threadId'];

		expect(
			isLatestRunReadyForThread({
				threadId,
				pendingCreatedThreadId: null,
				hasLatestRunData: false
			})
		).toBe(false);
		expect(
			isLatestRunReadyForThread({
				threadId,
				pendingCreatedThreadId: threadId,
				hasLatestRunData: false
			})
		).toBe(true);
		expect(
			isLatestRunReadyForThread({
				threadId,
				pendingCreatedThreadId: null,
				hasLatestRunData: true
			})
		).toBe(true);
	});

	it('scopes error cleanup to the matching thread and launch', () => {
		const threadA = 'thread-record-a' as ThreadSummary['threadId'];
		const threadB = 'thread-record-b' as ThreadSummary['threadId'];
		let pendingLaunches = beginPendingAgentLaunch({}, threadA, {
			expiresAt: 100,
			launchId: 1,
			previousRunId: null
		});
		pendingLaunches = beginPendingAgentLaunch(pendingLaunches, threadA, {
			expiresAt: 100,
			launchId: 2,
			previousRunId: 'run-a-1' as never
		});
		pendingLaunches = beginPendingAgentLaunch(pendingLaunches, threadB, {
			expiresAt: 100,
			launchId: 3,
			previousRunId: null
		});

		const unchanged = clearPendingAgentLaunch(pendingLaunches, threadA, 1);
		expect(unchanged).toBe(pendingLaunches);

		const afterThreadAError = clearPendingAgentLaunch(unchanged, threadA, 2);
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

	it('treats selection generations as current only when they match', () => {
		expect(isSelectionGenerationCurrent(3, 3)).toBe(true);
		expect(isSelectionGenerationCurrent(2, 3)).toBe(false);
	});
});
