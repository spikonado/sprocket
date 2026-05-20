import { describe, expect, it } from 'vitest';
import {
	countActiveThreads,
	findThreadById,
	getAttachedWorkspaceSessionIds,
	groupExecutorJobsByWorkspace,
	pickNextExecutorJobForWorkspace,
	resolveWorkspaceThreadSelection
} from '$lib/workspace/threads';
import { defaultModelId, defaultReasoningEffort } from '$lib/chat/models';
import type { ExecutorJob, ThreadSummary, WorkspaceSession } from '$lib/types/sprocket';

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

function makeExecutorJob(overrides: Partial<ExecutorJob> = {}): ExecutorJob {
	return {
		_id: (overrides._id ?? 'job-1') as ExecutorJob['_id'],
		workspaceSessionId: (overrides.workspaceSessionId ??
			'ws-1') as ExecutorJob['workspaceSessionId'],
		threadId: (overrides.threadId ?? 'thread-record-1') as ExecutorJob['threadId'],
		runId: (overrides.runId ?? 'run-1') as ExecutorJob['runId'],
		kind: overrides.kind ?? 'exec_command',
		payload: overrides.payload ?? { cmd: 'pwd' },
		hidden: overrides.hidden,
		status: overrides.status ?? 'pending',
		enqueuedAt: overrides.enqueuedAt ?? 0,
		claimedAt: overrides.claimedAt,
		completedAt: overrides.completedAt,
		result: overrides.result,
		error: overrides.error,
		sequence: overrides.sequence ?? 0
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

	it('groups jobs by workspace so different workspaces can process concurrently', () => {
		const grouped = groupExecutorJobsByWorkspace([
			makeExecutorJob({
				_id: 'job-1' as ExecutorJob['_id'],
				workspaceSessionId: 'ws-a' as ExecutorJob['workspaceSessionId']
			}),
			makeExecutorJob({
				_id: 'job-2' as ExecutorJob['_id'],
				workspaceSessionId: 'ws-b' as ExecutorJob['workspaceSessionId']
			}),
			makeExecutorJob({
				_id: 'job-3' as ExecutorJob['_id'],
				workspaceSessionId: 'ws-a' as ExecutorJob['workspaceSessionId']
			})
		]);

		expect([...grouped.keys()]).toEqual(['ws-a', 'ws-b']);
		expect(grouped.get('ws-a' as ExecutorJob['workspaceSessionId'])?.map((job) => job._id)).toEqual(
			['job-1', 'job-3']
		);
		expect(grouped.get('ws-b' as ExecutorJob['workspaceSessionId'])?.map((job) => job._id)).toEqual(
			['job-2']
		);
	});

	it('prefers an already-claimed job for the same workspace before a pending job', () => {
		const selectedJob = pickNextExecutorJobForWorkspace([
			makeExecutorJob({ _id: 'job-1' as ExecutorJob['_id'], status: 'pending', sequence: 0 }),
			makeExecutorJob({
				_id: 'job-2' as ExecutorJob['_id'],
				status: 'claimed',
				sequence: 1
			})
		]);

		expect(selectedJob?._id).toBe('job-2');
	});

	it('counts active threads for sidebar indicators', () => {
		expect(
			countActiveThreads([
				makeThreadSummary({ hasActiveRun: true }),
				makeThreadSummary({
					_id: 'thread-record-2' as ThreadSummary['_id'],
					threadId: 'thread-record-2' as ThreadSummary['threadId'],
					hasActiveRun: false
				}),
				makeThreadSummary({
					_id: 'thread-record-3' as ThreadSummary['_id'],
					threadId: 'thread-record-3' as ThreadSummary['threadId'],
					hasActiveRun: true
				})
			])
		).toBe(2);
	});

	it('finds a persisted thread when it still exists', () => {
		const thread = makeThreadSummary();

		expect(findThreadById([thread], thread.threadId)).toEqual(thread);
		expect(findThreadById([thread], 'missing-thread' as ThreadSummary['threadId'])).toBeNull();
	});

	it('preserves a blank draft selection for the current workspace', () => {
		const threads = [makeThreadSummary()];

		expect(
			resolveWorkspaceThreadSelection({
				threads,
				currentThreadId: null,
				currentWorkspaceSessionId: 'ws-1' as ThreadSummary['workspaceSessionId'],
				draftWorkspaceSessionId: 'ws-1' as ThreadSummary['workspaceSessionId']
			})
		).toBeNull();
	});

	it('falls back to the newest thread when no current selection is available', () => {
		const threads = [
			makeThreadSummary({ _id: 'thread-record-2' as ThreadSummary['_id'], lastMessageAt: 20 }),
			makeThreadSummary({ _id: 'thread-record-1' as ThreadSummary['_id'], lastMessageAt: 10 })
		];

		expect(
			resolveWorkspaceThreadSelection({
				threads,
				currentThreadId: null,
				currentWorkspaceSessionId: 'ws-1' as ThreadSummary['workspaceSessionId'],
				draftWorkspaceSessionId: null
			})
		).toBe('thread-record-2');
	});
});
