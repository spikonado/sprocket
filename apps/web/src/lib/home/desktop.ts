import type { Id } from '$convex/_generated/dataModel';
import type {
	AgentRunRequest,
	DesktopApi,
	LocalWorkspaceAvailability,
	RunState,
	WorkspaceSession,
	WorkspaceSessionAttachment,
	WorkspaceSessionLocation
} from '$lib/types/sprocket';
import { isRunClaimLeaseActive } from '$convex/lib/runLease';
import { isRunFinalStatus } from '$convex/lib/validators';

export type ViewerArgs = {
	guestId?: string;
};

export type WorkspaceSessionState = WorkspaceSession & {
	localWorkspaceAvailability: LocalWorkspaceAvailability;
};

export function getViewerArgs(
	authenticatedUser: unknown,
	guestSessionId: string | null
): ViewerArgs {
	return !authenticatedUser && guestSessionId ? { guestId: guestSessionId } : {};
}

export function getViewerIdentity(
	authenticatedUser: { id: string } | null | undefined,
	guestSessionId: string | null
): string | null {
	if (authenticatedUser) {
		return `user:${authenticatedUser.id}`;
	}

	return guestSessionId ? `guest:${guestSessionId}` : null;
}

export function resolveSubmissionId(args: {
	newSubmissionId: string;
	prompt: string;
	reasoningEffort: AgentRunRequest['reasoningEffort'];
	recoveredSubmission?: {
		prompt: string;
		reasoningEffort: AgentRunRequest['reasoningEffort'];
		selectedModel: AgentRunRequest['selectedModel'];
		submissionId: string;
	};
	latestRun: {
		status: RunState['status'];
		submissionId?: string;
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
		recoveredSubmission.reasoningEffort === args.reasoningEffort
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

export function getViewerQueryArgs(args: {
	authenticatedUser: unknown;
	convexIsAuthenticated: boolean;
	convexIsLoading: boolean;
	guestSessionId: string | null;
}): ViewerArgs | 'skip' {
	if (args.authenticatedUser) {
		return args.convexIsAuthenticated ? {} : 'skip';
	}

	if (args.convexIsLoading || args.convexIsAuthenticated) {
		return 'skip';
	}

	return args.guestSessionId ? { guestId: args.guestSessionId } : 'skip';
}

export function launchAgentRun(args: {
	authToken?: string;
	desktopApi: DesktopApi;
	onError: (error: unknown) => void;
	threadId: Id<'threadRecords'>;
	prompt: string;
	selectedModel: AgentRunRequest['selectedModel'];
	reasoningEffort: AgentRunRequest['reasoningEffort'];
	submissionId: string;
	viewerArgs: ViewerArgs;
	workspaceSessionId: Id<'workspaceSessions'>;
}) {
	void args.desktopApi
		.runAgent({
			...(args.authToken ? { authToken: args.authToken } : {}),
			...args.viewerArgs,
			threadId: args.threadId,
			prompt: args.prompt,
			selectedModel: args.selectedModel,
			reasoningEffort: args.reasoningEffort,
			submissionId: args.submissionId,
			workspaceSessionId: args.workspaceSessionId
		})
		.catch((error) => {
			console.error('Failed to run agent', error);
			args.onError(error);
		});
}

export function buildDesktopWorkspaceSessionsById(
	desktopWorkspaceSessions: WorkspaceSessionLocation[]
): Record<string, WorkspaceSessionLocation> {
	return Object.fromEntries(
		desktopWorkspaceSessions.map((workspaceSession) => [
			workspaceSession.workspaceSessionId,
			workspaceSession
		])
	);
}

export async function refreshDesktopWorkspaceSessions(desktopApi: DesktopApi | null) {
	if (!desktopApi) {
		return {};
	}

	return buildDesktopWorkspaceSessionsById(await desktopApi.listWorkspaceSessions());
}

export async function attachLocalWorkspaceSession(args: {
	desktopApi: DesktopApi;
	workspaceSessionId: Id<'workspaceSessions'>;
	workspacePath: string;
}) {
	return await args.desktopApi.attachWorkspaceSession({
		workspaceSessionId: args.workspaceSessionId,
		workspacePath: args.workspacePath
	} satisfies WorkspaceSessionAttachment);
}

export function getDesiredAttachedWorkspaceSessionIds(
	desktopWorkspaceSessions: WorkspaceSessionLocation[],
	backendWorkspaceSessionIds: Id<'workspaceSessions'>[]
): Id<'workspaceSessions'>[] {
	const backendWorkspaceSessionIdSet = new Set(backendWorkspaceSessionIds);
	return desktopWorkspaceSessions
		.filter(
			(workspaceSession) =>
				workspaceSession.availability === 'available' &&
				backendWorkspaceSessionIdSet.has(workspaceSession.workspaceSessionId)
		)
		.map((workspaceSession) => workspaceSession.workspaceSessionId);
}

type PendingLatestTask<T> = {
	value: T;
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: unknown) => void;
};

export class LatestTaskQueueCancelledError extends Error {
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
					task.reject(error);
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
			let rejectTask!: (error: unknown) => void;
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

export async function verifyWorkspaceSession(args: {
	desktopApi: DesktopApi | null;
	refreshDesktopWorkspaceSessions: () => Promise<void>;
	workspaceSessionId: Id<'workspaceSessions'>;
}) {
	if (!args.desktopApi) {
		return;
	}

	try {
		await args.desktopApi.getWorkspaceSessionOverview(args.workspaceSessionId);
		await args.refreshDesktopWorkspaceSessions();
	} catch (error) {
		await args.refreshDesktopWorkspaceSessions();
		throw error;
	}
}
