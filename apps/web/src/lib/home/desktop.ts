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
import { isRunClaimLeaseActive } from '$convex/lib/runLease';
import { isRunFinalStatus } from '$convex/lib/validators';
import { areImageUploadIdsEqual } from '$lib/chat/attachments';

export type ProjectState = Project & {
	localAttachmentAvailability: LocalAttachmentAvailability;
};

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
	projectId: Id<'projects'>;
}) {
	void args.desktopApi
		.runAgent({
			authToken: args.authToken,
			threadId: args.threadId,
			prompt: args.prompt,
			imageUploadIds: args.imageUploadIds,
			selectedModel: args.selectedModel,
			reasoningEffort: args.reasoningEffort,
			serviceTier: args.serviceTier,
			submissionId: args.submissionId,
			projectId: args.projectId
		})
		.then(({ runId }) => {
			args.onStarted(runId);
		})
		.catch((error) => {
			const failure = error instanceof Error ? error : new Error(String(error));
			console.error('Failed to run agent', failure);
			args.onError(failure);
		});
}

function buildDesktopProjectAttachmentsById(
	desktopProjectAttachments: ProjectAttachment[]
): Record<string, ProjectAttachment> {
	return Object.fromEntries(
		desktopProjectAttachments.map((attachment) => [attachment.projectId, attachment])
	);
}

export async function refreshDesktopProjectAttachments(desktopApi: DesktopApi | null) {
	if (!desktopApi) {
		return {};
	}

	return buildDesktopProjectAttachmentsById(await desktopApi.listProjectAttachments());
}

export async function attachLocalProject(args: {
	desktopApi: DesktopApi;
	projectId: Id<'projects'>;
	workspacePath: string;
}) {
	return await args.desktopApi.attachProject({
		projectId: args.projectId,
		workspacePath: args.workspacePath
	} satisfies ProjectAttachmentRequest);
}

export function getDesiredAttachedProjectIds(
	desktopProjectAttachments: ProjectAttachment[],
	backendProjectIds: Id<'projects'>[]
): Id<'projects'>[] {
	const backendProjectIdSet = new Set(backendProjectIds);
	return desktopProjectAttachments
		.filter(
			(attachment) =>
				attachment.availability === 'available' && backendProjectIdSet.has(attachment.projectId)
		)
		.map((attachment) => attachment.projectId);
}

type PendingLatestTask<T> = {
	value: T;
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: Error) => void;
};

class LatestTaskQueueCancelledError extends Error {
	constructor() {
		super('Pending task was canceled.');
		this.name = 'LatestTaskQueueCancelledError';
	}
}

export function createLatestTaskQueue<T>(run: (value: T) => Promise<void>) {
	let pending: PendingLatestTask<T> | null = null;
	let isRunning = false;

	async function drain() {
		if (isRunning) {
			return;
		}

		isRunning = true;
		try {
			while (pending) {
				const task = pending;
				pending = null;
				try {
					await run(task.value);
					task.resolve();
				} catch (error) {
					task.reject(error instanceof Error ? error : new Error('Pending task failed.'));
				}
			}
		} finally {
			isRunning = false;
			if (pending) {
				void drain();
			}
		}
	}

	return {
		enqueue(value: T): Promise<void> {
			if (pending) {
				pending.value = value;
				return pending.promise;
			}

			let resolveTask!: () => void;
			let rejectTask!: (error: Error) => void;
			const promise = new Promise<void>((resolve, reject) => {
				resolveTask = resolve;
				rejectTask = reject;
			});
			pending = { value, promise, resolve: resolveTask, reject: rejectTask };
			void drain();
			return promise;
		},
		cancelPending() {
			if (!pending) {
				return;
			}

			const task = pending;
			pending = null;
			task.reject(new LatestTaskQueueCancelledError());
		}
	};
}

export async function verifyProjectAttachment(args: {
	desktopApi: DesktopApi | null;
	refreshDesktopProjectAttachments: () => Promise<void>;
	projectId: Id<'projects'>;
}) {
	if (!args.desktopApi) {
		return;
	}

	try {
		const attachment = (await args.desktopApi.listProjectAttachments()).find(
			(candidate) => candidate.projectId === args.projectId
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
