import { describe, expect, it, vi } from 'vitest';
import type { Id } from '$convex/_generated/dataModel';
import {
	buildDesktopProjectAttachmentsByPath,
	launchAgentRun,
	resolveSubmissionId,
	upsertDesktopProjectAttachment
} from '$lib/home/desktop';
import type { DesktopApi, ProjectAttachment } from '$lib/types/sprocket';

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
		fetchTranscriptDisplay: unusedDesktopCall,
		fetchTranscriptDisplayDetails: unusedDesktopCall,
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
		settleThread: unusedDesktopCall,
		unsettleThread: unusedDesktopCall,
		rekeyRepository: unusedDesktopCall,
		requestRunCancellation: unusedDesktopCall,
		endAccountSession: unusedDesktopCall
	};
}

function projectAttachment(
	workspacePath: string,
	repositoryKey: string,
	lastUsedAt: number,
	availability: ProjectAttachment['availability'] = 'available',
	attachmentKey: string = `remote:${repositoryKey}`
): ProjectAttachment {
	return {
		workspacePath,
		repositoryKey,
		attachmentKey,
		displayName: repositoryKey,
		availability,
		lastValidatedAt: lastUsedAt,
		lastUsedAt
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

describe('local project attachments', () => {
	it('indexes one preferred directory per repository', () => {
		const indexed = buildDesktopProjectAttachmentsByPath([
			projectAttachment('/worktrees/main', 'github.com/acme/robot', 1),
			projectAttachment('/worktrees/feature', 'github.com/acme/robot', 2),
			projectAttachment('/worktrees/removed', 'github.com/acme/other', 1, 'unavailable'),
			projectAttachment('/worktrees/other', 'github.com/acme/other', 2)
		]);

		expect(Object.keys(indexed)).toEqual(['/worktrees/main', '/worktrees/other']);
	});

	it('selects the same directory when duplicate input order changes', () => {
		const older = projectAttachment('/worktrees/older', 'github.com/acme/robot', 1);
		const lexicalTie = projectAttachment('/worktrees/a-first', 'github.com/acme/robot', 1);
		const newer = projectAttachment('/worktrees/newer', 'github.com/acme/robot', 1);

		for (const attachments of [
			[older, lexicalTie, newer],
			[newer, older, lexicalTie]
		]) {
			expect(Object.keys(buildDesktopProjectAttachmentsByPath(attachments))).toEqual([
				'/worktrees/a-first'
			]);
		}
	});

	it('keeps unrelated local directories with the same display repository key', () => {
		const indexed = buildDesktopProjectAttachmentsByPath([
			projectAttachment('/clients/acme', 'acme', 1, 'available', 'directory:/clients/acme'),
			projectAttachment('/archive/acme', 'acme', 2, 'available', 'directory:/archive/acme')
		]);

		expect(Object.keys(indexed)).toEqual(['/clients/acme', '/archive/acme']);
	});

	it('replaces the displayed directory when the same repository is attached again', () => {
		const current = {
			'/worktrees/main': projectAttachment('/worktrees/main', 'github.com/acme/robot', 2),
			'/projects/other': projectAttachment('/projects/other', 'github.com/acme/other', 1)
		};
		const feature = projectAttachment('/worktrees/feature', 'github.com/acme/robot', 3);

		expect(upsertDesktopProjectAttachment(current, feature)).toEqual({
			'/projects/other': current['/projects/other'],
			'/worktrees/feature': feature
		});
	});
});
