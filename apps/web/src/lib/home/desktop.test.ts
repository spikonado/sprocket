import { describe, expect, it, vi } from 'vitest';
import type { Id } from '$convex/_generated/dataModel';
import { launchAgentRun, resolveSubmissionId } from '$lib/home/desktop';
import type { DesktopApi } from '$lib/types/sprocket';

function storageId(value: string): Id<'_storage'> {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return value as Id<'_storage'>;
}

function threadRecordId(value: string): Id<'threadRecords'> {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return value as Id<'threadRecords'>;
}

function runId(value: string): Id<'runs'> {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return value as Id<'runs'>;
}

function unusedDesktopCall(): Promise<never> {
	return Promise.reject(new Error('unused desktop API method'));
}

const recoveredSubmission = {
	prompt: 'Inspect the robot',
	storageIds: [storageId('storage-1')],
	reasoningEffort: 'medium' as const,
	fastMode: false,
	selectedModel: 'gpt-5.6-sol' as const,
	submissionId: 'recovered-id',
	continuationOfRunId: runId('parent-run')
};

function createDesktopApi(runAgent: DesktopApi['runAgent']): DesktopApi {
	return {
		browseFilesystem: unusedDesktopCall,
		listWorkspaceSkills: unusedDesktopCall,
		resolveWorkspacePath: unusedDesktopCall,
		listProjectAttachments: unusedDesktopCall,
		attachProject: unusedDesktopCall,
		runAgent,
		fetchTranscriptPage: unusedDesktopCall,
		fetchTranscriptDisplay: unusedDesktopCall,
		fetchTranscriptDisplayDetails: unusedDesktopCall,
		fetchTranscriptDetails: unusedDesktopCall,
		watchTranscript: unusedDesktopCall,
		watchLiveCompletion: unusedDesktopCall,
		clearTranscriptReplica: unusedDesktopCall,
		fetchTranscriptAttachment: unusedDesktopCall,
		uploadTranscriptAttachment: unusedDesktopCall,
		discardTranscriptAttachment: unusedDesktopCall,
		registerThreadCache: unusedDesktopCall,
		fetchThreadSnapshot: unusedDesktopCall,
		watchThreadCache: unusedDesktopCall,
		watchArtifacts: unusedDesktopCall,
		renameThread: unusedDesktopCall,
		archiveThread: unusedDesktopCall,
		restoreThread: unusedDesktopCall,
		rekeyRepository: unusedDesktopCall,
		requestRunCancellation: unusedDesktopCall,
		endAccountSession: unusedDesktopCall
	};
}

function launchArgs(
	overrides: Partial<Parameters<typeof launchAgentRun>[0]> &
		Pick<Parameters<typeof launchAgentRun>[0], 'desktopApi'>
): Parameters<typeof launchAgentRun>[0] {
	return {
		userId: 'user-1',
		onError: vi.fn(),
		onStarted: vi.fn(),
		threadId: threadRecordId('thread-1'),
		prompt: 'Inspect src/lib.rs',
		storageIds: [storageId('storage-1')],
		selectedModel: 'gpt-5.6-sol',
		reasoningEffort: 'medium',
		fastMode: false,
		submissionId: 'submission-1',
		workspacePath: '/workspaces/workspace-1',
		...overrides
	};
}

function resolveRecoveredSubmission(
	overrides: Partial<Parameters<typeof resolveSubmissionId>[0]> = {}
) {
	return resolveSubmissionId({
		latestRun: null,
		newSubmissionId: 'new-id',
		prompt: recoveredSubmission.prompt,
		storageIds: recoveredSubmission.storageIds,
		reasoningEffort: recoveredSubmission.reasoningEffort,
		fastMode: recoveredSubmission.fastMode,
		continuationOfRunId: recoveredSubmission.continuationOfRunId,
		recoveredSubmission,
		selectedModel: recoveredSubmission.selectedModel,
		...overrides
	});
}

describe('launchAgentRun', () => {
	it('acknowledges a durably created desktop run', async () => {
		const runAgent = vi.fn().mockResolvedValue({ runId: 'run-1', threadId: 'thread-1' });
		const desktopApi = createDesktopApi(runAgent);
		const onStarted = vi.fn();

		await launchAgentRun(launchArgs({ desktopApi, onStarted }));

		expect(runAgent).toHaveBeenCalledWith({
			userId: 'user-1',
			threadId: 'thread-1',
			prompt: 'Inspect src/lib.rs',
			storageIds: ['storage-1'],
			selectedModel: 'gpt-5.6-sol',
			submissionId: 'submission-1',
			reasoningEffort: 'medium',
			fastMode: false,
			workspacePath: '/workspaces/workspace-1'
		});
		expect(onStarted).toHaveBeenCalledWith('run-1', 'thread-1');
	});

	it('forwards continuationOfRunId without a duplicated prompt', async () => {
		const runAgent = vi.fn().mockResolvedValue({ runId: 'run-2', threadId: 'thread-1' });
		const desktopApi = createDesktopApi(runAgent);

		await launchAgentRun(
			launchArgs({
				desktopApi,
				prompt: '',
				storageIds: [],
				continuationOfRunId: runId('run-1')
			})
		);

		expect(runAgent).toHaveBeenCalledWith({
			userId: 'user-1',
			threadId: 'thread-1',
			prompt: '',
			storageIds: [],
			selectedModel: 'gpt-5.6-sol',
			submissionId: 'submission-1',
			reasoningEffort: 'medium',
			fastMode: false,
			workspacePath: '/workspaces/workspace-1',
			continuationOfRunId: 'run-1'
		});
	});

	it('reports asynchronous launch failures through onError', async () => {
		const launchError = new Error('desktop launch failed');
		const onError = vi.fn();
		const desktopApi = createDesktopApi(vi.fn().mockRejectedValue(launchError));

		await launchAgentRun(launchArgs({ desktopApi, onError }));

		expect(onError).toHaveBeenCalledWith(launchError);
	});
});

describe('resolveSubmissionId', () => {
	it('reuses an uncertain submission only when its restored prompt is unchanged', () => {
		expect(resolveRecoveredSubmission()).toBe('recovered-id');
		expect(resolveRecoveredSubmission({ prompt: 'Inspect and fix the robot' })).toBe('new-id');
		expect(resolveRecoveredSubmission({ reasoningEffort: 'high' })).toBe('new-id');
		expect(resolveRecoveredSubmission({ fastMode: true })).toBe('new-id');
		expect(resolveRecoveredSubmission({ continuationOfRunId: undefined })).toBe('new-id');
	});

	it('reuses a submission only when its attachments are unchanged', () => {
		expect(resolveRecoveredSubmission({ storageIds: [] })).toBe('new-id');
		expect(resolveRecoveredSubmission({ storageIds: [storageId('storage-2')] })).toBe('new-id');
		expect(
			resolveRecoveredSubmission({
				storageIds: [storageId('storage-1'), storageId('storage-2')]
			})
		).toBe('new-id');
	});

	it('reuses only for the expected parent or the same unfinished run', () => {
		expect(
			resolveRecoveredSubmission({
				latestRun: { status: 'failed', submissionId: 'recovered-id' }
			})
		).toBe('new-id');
		expect(
			resolveRecoveredSubmission({
				latestRun: {
					runId: recoveredSubmission.continuationOfRunId,
					status: 'completed',
					submissionId: 'parent-id'
				}
			})
		).toBe('recovered-id');
		expect(
			resolveRecoveredSubmission({
				latestRun: { status: 'queued', submissionId: 'recovered-id' }
			})
		).toBe('recovered-id');
		expect(
			resolveRecoveredSubmission({
				latestRun: { status: 'queued', submissionId: 'newer-id' }
			})
		).toBe('new-id');
	});
});
