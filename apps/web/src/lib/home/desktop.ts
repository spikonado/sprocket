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
import { RUN_ABANDONED_BY_AGENT } from '$convex/lib/agentErrors';
import { isRunFinalStatus } from '$convex/lib/validators';
import type { SelectedThreadLifecyclePhase } from '$convex/lib/runCancellation';
import { areStorageIdsEqual } from '$lib/chat/attachments';

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
	storageIds: Id<'_storage'>[];
	reasoningEffort: AgentRunRequest['reasoningEffort'];
	fastMode: AgentRunRequest['fastMode'];
	recoveredSubmission?: {
		prompt: string;
		storageIds?: Id<'_storage'>[];
		reasoningEffort: AgentRunRequest['reasoningEffort'];
		fastMode: AgentRunRequest['fastMode'];
		selectedModel: AgentRunRequest['selectedModel'];
		submissionId: string;
		continuationOfRunId?: Id<'runs'>;
	};
	latestRun: {
		runId?: Id<'runs'>;
		status: RunState['status'];
		submissionId: string;
	} | null;
	selectedModel: AgentRunRequest['selectedModel'];
	continuationOfRunId?: Id<'runs'>;
}) {
	const recoveredSubmission = args.recoveredSubmission;
	const latestRun = args.latestRun;
	const canReuseRecoveredSubmission =
		latestRun === null ||
		(latestRun.runId !== undefined &&
			latestRun.runId === recoveredSubmission?.continuationOfRunId) ||
		(latestRun.submissionId === recoveredSubmission?.submissionId &&
			!isRunFinalStatus(latestRun.status));
	return canReuseRecoveredSubmission &&
		recoveredSubmission?.prompt === args.prompt &&
		recoveredSubmission.selectedModel === args.selectedModel &&
		recoveredSubmission.reasoningEffort === args.reasoningEffort &&
		recoveredSubmission.fastMode === args.fastMode &&
		recoveredSubmission.continuationOfRunId === args.continuationOfRunId &&
		areStorageIdsEqual(recoveredSubmission.storageIds, args.storageIds)
		? recoveredSubmission.submissionId
		: args.newSubmissionId;
}

export type RunResumeKind = 'crash' | 'failed' | 'cancelled';

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
	userId: string;
	desktopApi: DesktopApi;
	onError: (error: Error) => void;
	onStarted: (runId: Id<'runs'>, threadId: Id<'threadRecords'>) => void;
	threadId?: Id<'threadRecords'>;
	repositoryKey?: string;
	prompt: string;
	storageIds: Id<'_storage'>[];
	selectedModel: AgentRunRequest['selectedModel'];
	reasoningEffort: AgentRunRequest['reasoningEffort'];
	fastMode: AgentRunRequest['fastMode'];
	submissionId: string;
	workspacePath: string;
	continuationOfRunId?: Id<'runs'>;
}) {
	const request: AgentRunRequest = {
		userId: args.userId,
		prompt: args.prompt,
		storageIds: args.storageIds,
		selectedModel: args.selectedModel,
		reasoningEffort: args.reasoningEffort,
		fastMode: args.fastMode,
		submissionId: args.submissionId,
		workspacePath: args.workspacePath
	};
	if (args.threadId) request.threadId = args.threadId;
	if (args.repositoryKey) request.repositoryKey = args.repositoryKey;
	if (args.continuationOfRunId) {
		request.continuationOfRunId = args.continuationOfRunId;
	}
	return args.desktopApi
		.runAgent(request)
		.then(({ runId, threadId }) => {
			args.onStarted(runId, threadId);
		})
		.catch((error) => {
			const failure = error instanceof Error ? error : new Error(String(error));
			console.error('Failed to run agent', failure);
			args.onError(failure);
		});
}

function attachmentIsPreferred(candidate: ProjectAttachment, current: ProjectAttachment) {
	if (candidate.availability !== current.availability) {
		return candidate.availability === 'available';
	}
	if (candidate.lastUsedAt !== current.lastUsedAt) {
		return candidate.lastUsedAt < current.lastUsedAt;
	}
	return candidate.workspacePath < current.workspacePath;
}

export function buildDesktopProjectAttachmentsByPath(
	desktopProjectAttachments: ProjectAttachment[]
): Record<string, ProjectAttachment> {
	const attachmentsByRepository = new Map<string, ProjectAttachment>();
	for (const attachment of desktopProjectAttachments) {
		const attachmentKey = attachment.attachmentKey;
		const current = attachmentsByRepository.get(attachmentKey);
		if (!current || attachmentIsPreferred(attachment, current)) {
			attachmentsByRepository.set(attachmentKey, attachment);
		}
	}
	return Object.fromEntries(
		[...attachmentsByRepository.values()].map((attachment) => [
			attachment.workspacePath,
			attachment
		])
	);
}

export function findCanonicalProjectAttachment(
	attachmentsByPath: Record<string, ProjectAttachment>,
	workspace: { workspacePath: string; repositoryKey: string }
): ProjectAttachment | undefined {
	const attachmentAtPath = attachmentsByPath[workspace.workspacePath];
	if (
		attachmentAtPath?.availability === 'available' &&
		attachmentAtPath.repositoryKey === workspace.repositoryKey
	) {
		return attachmentAtPath;
	}
	return Object.values(attachmentsByPath).find(
		(attachment) =>
			attachment.availability === 'available' &&
			attachment.repositoryKey === workspace.repositoryKey
	);
}

export function upsertDesktopProjectAttachment(
	desktopProjectAttachmentsByPath: Record<string, ProjectAttachment>,
	attachment: ProjectAttachment,
	replaceWorkspacePath?: string
): Record<string, ProjectAttachment> {
	const nextAttachments = Object.fromEntries(
		Object.entries(desktopProjectAttachmentsByPath).filter(
			([workspacePath, existing]) =>
				workspacePath !== replaceWorkspacePath &&
				workspacePath !== attachment.workspacePath &&
				existing.attachmentKey !== attachment.attachmentKey
		)
	);
	nextAttachments[attachment.workspacePath] = attachment;
	return nextAttachments;
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
