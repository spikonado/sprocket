import { describe, expect, it } from 'vitest';
import { defaultModelId, defaultReasoningEffort } from '$lib/models';
import { findThreadById, resolveWorkspaceThreadSelection } from '$lib/thread-selection';
import type { ThreadSummary } from '$lib/types/sprocket';

function makeThreadSummary(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
	return {
		_id: (overrides._id ?? 'thread-record-1') as ThreadSummary['_id'],
		threadId: (overrides.threadId ??
			overrides._id ??
			'thread-record-1') as ThreadSummary['threadId'],
		workspaceSessionId: (overrides.workspaceSessionId ??
			'workspace-1') as ThreadSummary['workspaceSessionId'],
		workspacePath: overrides.workspacePath ?? '/tmp/workspace',
		workspaceName: overrides.workspaceName ?? 'Workspace',
		title: overrides.title ?? 'Workspace Thread',
		selectedModel: overrides.selectedModel ?? defaultModelId,
		reasoningEffort: overrides.reasoningEffort ?? defaultReasoningEffort,
		lastMessageAt: overrides.lastMessageAt ?? 1,
		threadStatus: overrides.threadStatus ?? 'active',
		latestRunStatus: overrides.latestRunStatus ?? null,
		latestRunStartedAt: overrides.latestRunStartedAt,
		hasActiveRun: overrides.hasActiveRun ?? false
	};
}

describe('thread selection helpers', () => {
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
				currentWorkspaceSessionId: 'workspace-1' as ThreadSummary['workspaceSessionId'],
				draftWorkspaceSessionId: 'workspace-1' as ThreadSummary['workspaceSessionId']
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
				currentWorkspaceSessionId: 'workspace-1' as ThreadSummary['workspaceSessionId'],
				draftWorkspaceSessionId: null
			})
		).toBe('thread-record-2');
	});
});
