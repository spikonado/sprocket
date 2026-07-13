import { describe, expect, it } from 'vitest';
import {
	dataForThread,
	findWorkspaceSessionByName,
	getAttachedWorkspaceSessionIds,
	getWorkspaceThreadGroups,
	isSelectionGenerationCurrent,
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
		latestRunStartedAt: undefined,
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

	it('clears pending created ids once the list catches up or create visibility fails', () => {
		const existing = makeThreadSummary({
			_id: 'thread-record-old' as ThreadSummary['_id'],
			threadId: 'thread-record-old' as ThreadSummary['threadId']
		});
		const pendingThreadId = 'thread-record-new' as ThreadSummary['threadId'];
		const created = makeThreadSummary({
			_id: pendingThreadId,
			threadId: pendingThreadId
		});

		expect(
			resolvePendingCreatedThreadId({
				pendingCreatedThreadId: pendingThreadId,
				threads: [existing],
				threadListChangedSinceCreate: false
			})
		).toBe(pendingThreadId);

		expect(
			resolvePendingCreatedThreadId({
				pendingCreatedThreadId: pendingThreadId,
				threads: [created, existing],
				threadListChangedSinceCreate: true
			})
		).toBeNull();

		expect(
			resolvePendingCreatedThreadId({
				pendingCreatedThreadId: pendingThreadId,
				threads: [existing],
				threadListChangedSinceCreate: true
			})
		).toBeNull();
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
