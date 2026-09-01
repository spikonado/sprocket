import type { Id } from '$convex/_generated/dataModel';
import type {
	AgentRunRequest,
	DesktopApi,
	LocalAttachmentAvailability,
	Project,
	ProjectAttachment,
	ProjectAttachmentRequest,
	RunState
} from '$lib/types/sprocket';
import { isClaimedRunStatus, isRunClaimLeaseActive } from '$convex/lib/runLease';
import { RUN_ABANDONED_BY_AGENT } from '$convex/lib/agentErrors';
import { isRunFinalStatus } from '$convex/lib/validators';
import type { SelectedThreadLifecyclePhase } from '$convex/lib/runCancellation';
import { areImageUploadIdsEqual } from '$lib/chat/attachments';

export type ProjectState = Project & {
	localAttachmentAvailability: LocalAttachmentAvailability;
};

export function projectFromAttachment(attachment: ProjectAttachment): ProjectState {
	return {
		repositoryKey: attachment.repositoryKey,
		displayName: attachment.displayName,
		workspacePath: attachment.workspacePath,
		localAttachmentAvailability: attachment.availability,
		localAttachmentError: attachment.unavailableReason
	};
}

export function resolveSubmissionId(args: {
	newSubmissionId: string;
	prompt: string;
	imageUploadIds: Id<'imageUploads'>[];
	reasoningEffort: AgentRunRequest['reasoningEffort'];
	serviceTier: AgentRunRequest['serviceTier'];
	recoveredSubmission?: {
		prompt: string;
		imageUploadIds?: Id<'imageUploads'>[];
		reasoningEffort: AgentRunRequest['reasoningEffort'];
		serviceTier: AgentRunRequest['serviceTier'];
		selectedModel: AgentRunRequest['selectedModel'];
		submissionId: string;
	};
	latestRun: {
		status: RunState['status'];
		submissionId: string;
	} | null;
	selectedModel: AgentRunRequest['selectedModel'];
}) {
	const recoveredSubmission = args.recoveredSubmission;
	const latestRun = args.latestRun;
	const canReuseRecoveredSubmission =
		latestRun === null ||
		(latestRun.submissionId === recoveredSubmission?.submissionId &&
			!isRunFinalStatus(latestRun.status));
	return canReuseRecoveredSubmission &&
		recoveredSubmission?.prompt === args.prompt &&
		recoveredSubmission.selectedModel === args.selectedModel &&
		recoveredSubmission.reasoningEffort === args.reasoningEffort &&
		recoveredSubmission.serviceTier === args.serviceTier &&
		areImageUploadIdsEqual(recoveredSubmission.imageUploadIds, args.imageUploadIds)
		? recoveredSubmission.submissionId
		: args.newSubmissionId;
}

export function resolveDraftRunSubmissionId(args: {
	freshSubmissionId: string;
	submissionRunStatus: RunState['status'] | null;
	threadSubmissionId: string;
}) {
	return args.submissionRunStatus && isRunFinalStatus(args.submissionRunStatus)
		? args.freshSubmissionId
		: args.threadSubmissionId;
}

export function isRunBlockingAgentLaunch(
	run: Pick<RunState, 'status' | 'claimExpiresAt'> | null,
	now: number
): boolean {
	if (!run) return false;
	if (run.status === 'queued') return true;
	return isRunClaimLeaseActive(run, now);
}

export type RunResumeKind = 'crash' | 'failed' | 'cancelled';

export function runResumeKind(
	run: Pick<RunState, 'status' | 'claimExpiresAt' | 'lastError'> | null,
	now: number
): RunResumeKind | null {
	if (!run) return null;
	if (run.status === 'cancelled') return 'cancelled';
	if (run.status === 'failed') {
		return run.lastError === RUN_ABANDONED_BY_AGENT ? 'crash' : 'failed';
	}
	if (isClaimedRunStatus(run.status) && !isRunClaimLeaseActive(run, now)) {
		return 'crash';
	}
	return null;
}

export function lifecycleResumeKind(
	phase: SelectedThreadLifecyclePhase,
	lastError?: string
): RunResumeKind | null {
	if (phase === 'cancelled') return 'cancelled';
	if (phase === 'failed') {
		return lastError === RUN_ABANDONED_BY_AGENT ? 'crash' : 'failed';
	}
	return null;
}

export function launchAgentRun(args: {
	authToken: string;
	desktopApi: DesktopApi;
	onError: (error: Error) => void;
	onStarted: (runId: Id<'runs'>) => void;
	threadId: Id<'threadRecords'>;
	prompt: string;
	imageUploadIds: Id<'imageUploads'>[];
	selectedModel: AgentRunRequest['selectedModel'];
	reasoningEffort: AgentRunRequest['reasoningEffort'];
	serviceTier: AgentRunRequest['serviceTier'];
	submissionId: string;
	workspacePath: string;
	continuationOfRunId?: Id<'runs'>;
}) {
	const request: AgentRunRequest = {
		authToken: args.authToken,
		threadId: args.threadId,
		prompt: args.prompt,
		imageUploadIds: args.imageUploadIds,
		selectedModel: args.selectedModel,
		reasoningEffort: args.reasoningEffort,
		serviceTier: args.serviceTier,
		submissionId: args.submissionId,
		workspacePath: args.workspacePath
	};
	if (args.continuationOfRunId) {
		request.continuationOfRunId = args.continuationOfRunId;
	}
	void args.desktopApi
		.runAgent(request)
		.then(({ runId }) => {
			args.onStarted(runId);
		})
		.catch((error) => {
			const failure = error instanceof Error ? error : new Error(String(error));
			console.error('Failed to run agent', failure);
			args.onError(failure);
		});
}

function buildDesktopProjectAttachmentsByPath(
	desktopProjectAttachments: ProjectAttachment[]
): Record<string, ProjectAttachment> {
	return Object.fromEntries(
		desktopProjectAttachments.map((attachment) => [attachment.workspacePath, attachment])
	);
}

export async function refreshDesktopProjectAttachments(desktopApi: DesktopApi | null) {
	if (!desktopApi) {
		return {};
	}

	return buildDesktopProjectAttachmentsByPath(await desktopApi.listProjectAttachments());
}

export async function attachLocalProject(args: {
	desktopApi: DesktopApi;
	workspacePath: string;
	replaceWorkspacePath?: string;
}) {
	const request: ProjectAttachmentRequest = {
		workspacePath: args.workspacePath
	};
	if (args.replaceWorkspacePath) {
		request.replaceWorkspacePath = args.replaceWorkspacePath;
	}
	return await args.desktopApi.attachProject(request);
}

export async function verifyProjectAttachment(args: {
	desktopApi: DesktopApi | null;
	refreshDesktopProjectAttachments: () => Promise<void>;
	workspacePath: string;
}) {
	if (!args.desktopApi) {
		return;
	}

	try {
		const attachment = (await args.desktopApi.listProjectAttachments()).find(
			(candidate) => candidate.workspacePath === args.workspacePath
		);
		if (!attachment || attachment.availability !== 'available') {
			throw new Error(attachment?.unavailableReason ?? 'Workspace path is unavailable.');
		}
		await args.refreshDesktopProjectAttachments();
	} catch (error) {
		await args.refreshDesktopProjectAttachments();
		throw error;
	}
}
