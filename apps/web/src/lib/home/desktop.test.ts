import { describe, expect, it, vi } from 'vitest';
import type { Id } from '$convex/_generated/dataModel';
import {
	isRunBlockingAgentLaunch,
	launchAgentRun,
	resolveDraftRunSubmissionId,
	resolveSubmissionId,
	runResumeKind
} from '$lib/home/desktop';
import { RUN_ABANDONED_BY_AGENT } from '$convex/lib/agentErrors';
import type { DesktopApi, RunState } from '$lib/types/sprocket';

function imageUploadId(value: string): Id<'imageUploads'> {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return value as Id<'imageUploads'>;
}

function threadRecordId(value: string): Id<'threadRecords'> {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return value as Id<'threadRecords'>;
}

function unusedDesktopCall(): Promise<never> {
	return Promise.reject(new Error('unused desktop API method'));
}

const recoveredSubmission = {
	prompt: 'Inspect the robot',
	imageUploadIds: [imageUploadId('image-1')],
	reasoningEffort: 'medium' as const,
	serviceTier: 'standard' as const,
	selectedModel: 'gpt-5.6-sol' as const,
	submissionId: 'recovered-id'
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
		watchTranscript: unusedDesktopCall,
		watchLiveCompletion: unusedDesktopCall,
		clearTranscriptReplica: unusedDesktopCall,
		fetchTranscriptAttachment: unusedDesktopCall
	};
}

function launchArgs(
	overrides: Partial<Parameters<typeof launchAgentRun>[0]> &
		Pick<Parameters<typeof launchAgentRun>[0], 'desktopApi'>
): Parameters<typeof launchAgentRun>[0] {
	return {
		authToken: 'token-1',
		onError: vi.fn(),
		onStarted: vi.fn(),
		threadId: threadRecordId('thread-1'),
		prompt: 'Inspect src/lib.rs',
		imageUploadIds: [imageUploadId('image-1')],
		selectedModel: 'gpt-5.6-sol',
		reasoningEffort: 'medium',
		serviceTier: 'standard',
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
		imageUploadIds: recoveredSubmission.imageUploadIds,
		reasoningEffort: recoveredSubmission.reasoningEffort,
		serviceTier: recoveredSubmission.serviceTier,
		recoveredSubmission,
		selectedModel: recoveredSubmission.selectedModel,
		...overrides
	});
}

describe('launchAgentRun', () => {
	it('acknowledges a durably created desktop run', async () => {
		const runAgent = vi.fn().mockResolvedValue({ runId: 'run-1' });
		const desktopApi = createDesktopApi(runAgent);
		const onStarted = vi.fn();

		launchAgentRun(launchArgs({ desktopApi, onStarted }));

		expect(runAgent).toHaveBeenCalledWith({
			authToken: 'token-1',
			threadId: 'thread-1',
			prompt: 'Inspect src/lib.rs',
			imageUploadIds: ['image-1'],
			selectedModel: 'gpt-5.6-sol',
			submissionId: 'submission-1',
			reasoningEffort: 'medium',
			serviceTier: 'standard',
			workspacePath: '/workspaces/workspace-1'
		});
		await vi.waitFor(() => {
			expect(onStarted).toHaveBeenCalledWith('run-1');
		});
	});

	it('reports asynchronous launch failures through onError', async () => {
		const launchError = new Error('desktop launch failed');
		const onError = vi.fn();
		const desktopApi = createDesktopApi(vi.fn().mockRejectedValue(launchError));

		launchAgentRun(launchArgs({ desktopApi, onError }));

		await vi.waitFor(() => {
			expect(onError).toHaveBeenCalledWith(launchError);
		});
	});
});

describe('resolveSubmissionId', () => {
	it('reuses an uncertain submission only when its restored prompt is unchanged', () => {
		expect(resolveRecoveredSubmission()).toBe('recovered-id');
		expect(resolveRecoveredSubmission({ prompt: 'Inspect and fix the robot' })).toBe('new-id');
		expect(resolveRecoveredSubmission({ reasoningEffort: 'high' })).toBe('new-id');
		expect(resolveRecoveredSubmission({ serviceTier: 'fast' })).toBe('new-id');
	});

	it('reuses a submission only when its image attachments are unchanged', () => {
		expect(resolveRecoveredSubmission({ imageUploadIds: [] })).toBe('new-id');
		expect(resolveRecoveredSubmission({ imageUploadIds: [imageUploadId('image-2')] })).toBe(
			'new-id'
		);
		expect(
			resolveRecoveredSubmission({
				imageUploadIds: [imageUploadId('image-1'), imageUploadId('image-2')]
			})
		).toBe('new-id');
	});

	it('uses a fresh id when the visible latest submission has finished or supersedes recovery', () => {
		expect(
			resolveRecoveredSubmission({
				latestRun: { status: 'failed', submissionId: 'recovered-id' }
			})
		).toBe('new-id');
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

describe('resolveDraftRunSubmissionId', () => {
	it.each(['completed', 'failed', 'cancelled'] as const)(
		'uses a fresh run submission after draft creation reveals a %s run',
		(submissionRunStatus) => {
			expect(
				resolveDraftRunSubmissionId({
					freshSubmissionId: 'fresh-id',
					submissionRunStatus,
					threadSubmissionId: 'recovered-id'
				})
			).toBe('fresh-id');
		}
	);

	it.each([null, 'queued', 'running', 'awaiting_executor'] as const)(
		'reuses the draft submission when its run is %s',
		(submissionRunStatus) => {
			expect(
				resolveDraftRunSubmissionId({
					freshSubmissionId: 'fresh-id',
					submissionRunStatus,
					threadSubmissionId: 'recovered-id'
				})
			).toBe('recovered-id');
		}
	);
});

describe('isRunBlockingAgentLaunch', () => {
	it('blocks queued and actively leased runs', () => {
		const run = (
			status: RunState['status'],
			claimExpiresAt?: number
		): Pick<RunState, 'status' | 'claimExpiresAt'> => {
			const next: Pick<RunState, 'status' | 'claimExpiresAt'> = { status };
			if (claimExpiresAt !== undefined) {
				next.claimExpiresAt = claimExpiresAt;
			}
			return next;
		};

		expect(isRunBlockingAgentLaunch(run('queued'), 100)).toBe(true);
		expect(isRunBlockingAgentLaunch(run('running', 101), 100)).toBe(true);
		expect(isRunBlockingAgentLaunch(run('awaiting_executor', 100), 100)).toBe(false);
	});
});

describe('runResumeKind', () => {
	it('classifies crashed, failed, and cancelled latest runs', () => {
		expect(runResumeKind({ status: 'running', claimExpiresAt: 50 }, 100)).toBe('crash');
		expect(
			runResumeKind(
				{
					status: 'failed',
					lastError: RUN_ABANDONED_BY_AGENT
				},
				100
			)
		).toBe('crash');
		expect(runResumeKind({ status: 'failed', lastError: 'boom' }, 100)).toBe('failed');
		expect(runResumeKind({ status: 'cancelled' }, 100)).toBe('cancelled');
		expect(runResumeKind({ status: 'completed' }, 100)).toBeNull();
		expect(runResumeKind({ status: 'running', claimExpiresAt: 150 }, 100)).toBeNull();
	});
});
