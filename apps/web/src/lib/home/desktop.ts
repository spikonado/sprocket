import type { Id } from '$convex/_generated/dataModel';
import type {
	AgentAuthStatus,
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

const AGENT_AUTH_INITIAL_RETRY_DELAY_MS = 250;
const AGENT_AUTH_MAX_RETRY_DELAY_MS = 4_000;
const AGENT_AUTH_NOT_FOUND_GRACE_MS = 10_000;

export type WorkspaceSessionState = WorkspaceSession & {
	localWorkspaceAvailability: LocalWorkspaceAvailability;
};

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

export function shouldSkipAuthenticatedQueries(args: {
	authenticatedUser: unknown;
	convexIsAuthenticated: boolean;
	convexIsLoading: boolean;
}): boolean {
	return !(args.authenticatedUser && args.convexIsAuthenticated && !args.convexIsLoading);
}

export function launchAgentRun(args: {
	authToken: string;
	desktopApi: DesktopApi;
	expectedUserId: string;
	getAccessToken: (options: { forceRefreshToken: boolean }) => Promise<string | null>;
	getCurrentUserId: () => string | null;
	onError: (error: unknown) => void;
	onStarted: (runId: Id<'runs'>) => void;
	threadId: Id<'threadRecords'>;
	prompt: string;
	selectedModel: AgentRunRequest['selectedModel'];
	reasoningEffort: AgentRunRequest['reasoningEffort'];
	submissionId: string;
	workspaceSessionId: Id<'workspaceSessions'>;
}) {
	const authSessionId = crypto.randomUUID();
	let settleLaunch!: () => void;
	const launchState = {
		status: 'pending' as 'pending' | 'acknowledged' | 'failed',
		notFoundGraceElapsed: false,
		settled: new Promise<void>((resolve) => {
			settleLaunch = resolve;
		})
	};
	let errorReported = false;
	const reportError = (error: unknown) => {
		if (errorReported) return;
		errorReported = true;
		console.error('Failed to run agent', error);
		args.onError(error);
	};
	const handleMonitorError = async (error: unknown) => {
		if (launchState.status === 'pending') await launchState.settled;
		if (launchState.status === 'failed') reportError(error);
	};

	void monitorAgentAuthSession({
		authSessionId,
		desktopApi: args.desktopApi,
		expectedUserId: args.expectedUserId,
		getAccessToken: args.getAccessToken,
		getCurrentUserId: args.getCurrentUserId,
		launchState
	}).catch(handleMonitorError);

	void args.desktopApi
		.runAgent({
			authSessionId,
			authToken: args.authToken,
			threadId: args.threadId,
			prompt: args.prompt,
			selectedModel: args.selectedModel,
			reasoningEffort: args.reasoningEffort,
			submissionId: args.submissionId,
			workspaceSessionId: args.workspaceSessionId
		})
		.then(({ runId }) => {
			launchState.status = 'acknowledged';
			settleLaunch();
			args.onStarted(runId);
		})
		.catch((error) => {
			launchState.status = 'failed';
			settleLaunch();
			if (!launchState.notFoundGraceElapsed) reportError(error);
		});
}

async function monitorAgentAuthSession(args: {
	authSessionId: string;
	desktopApi: DesktopApi;
	expectedUserId: string;
	getAccessToken: (options: { forceRefreshToken: boolean }) => Promise<string | null>;
	getCurrentUserId: () => string | null;
	launchState: {
		status: 'pending' | 'acknowledged' | 'failed';
		notFoundGraceElapsed: boolean;
		settled: Promise<void>;
	};
}) {
	const readLaunchStatus = () => args.launchState.status;
	let pendingToken: string | null = null;
	let retryDelayMs = AGENT_AUTH_INITIAL_RETRY_DELAY_MS;
	let notFoundSince: number | null = null;

	while (true) {
		let status: AgentAuthStatus;
		try {
			status = await args.desktopApi.waitForAgentAuthRefresh(args.authSessionId);
		} catch {
			await delay(retryDelayMs);
			retryDelayMs = Math.min(retryDelayMs * 2, AGENT_AUTH_MAX_RETRY_DELAY_MS);
			continue;
		}

		if (status === 'complete') return;
		if (status === 'notFound') {
			if (args.launchState.status === 'acknowledged') return;
			notFoundSince ??= Date.now();
			if (Date.now() - notFoundSince >= AGENT_AUTH_NOT_FOUND_GRACE_MS) {
				args.launchState.notFoundGraceElapsed = true;
				if (args.launchState.status === 'pending') await args.launchState.settled;
				if (readLaunchStatus() === 'acknowledged') return;
				throw new Error(
					'The local agent authentication session was not found. Start the run again.'
				);
			}
			await delay(retryDelayMs);
			retryDelayMs = Math.min(retryDelayMs * 2, AGENT_AUTH_MAX_RETRY_DELAY_MS);
			continue;
		}

		notFoundSince = null;
		if (!pendingToken) {
			assertAgentRunUser(args.expectedUserId, args.getCurrentUserId());
			pendingToken = await args.getAccessToken({ forceRefreshToken: true });
			if (!pendingToken) {
				throw new Error('Your session ended while the agent was running. Sign in again.');
			}
		}

		assertAgentRunUser(args.expectedUserId, args.getCurrentUserId());
		try {
			await args.desktopApi.refreshAgentAuth(args.authSessionId, pendingToken);
			pendingToken = null;
			retryDelayMs = AGENT_AUTH_INITIAL_RETRY_DELAY_MS;
		} catch {
			await delay(retryDelayMs);
			retryDelayMs = Math.min(retryDelayMs * 2, AGENT_AUTH_MAX_RETRY_DELAY_MS);
		}
	}
}

function assertAgentRunUser(expectedUserId: string, currentUserId: string | null) {
	if (!currentUserId) {
		throw new Error('Your session ended while the agent was running. Sign in again.');
	}
	if (currentUserId !== expectedUserId) {
		throw new Error(
			'Your account changed while the agent was running. Switch back and start again.'
		);
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
