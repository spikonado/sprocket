import { api } from '$convex/_generated/api';
import type { Id } from '$convex/_generated/dataModel';
import type { ConvexClient } from 'convex/browser';
import {
	groupExecutorJobsByWorkspace,
	pickNextExecutorJobForWorkspace
} from '$lib/workspace/threads';
import type {
	DesktopApi,
	ExecutorJob,
	LocalWorkspaceAvailability,
	WorkspaceSession,
	WorkspaceSessionAttachment,
	WorkspaceSessionLocation,
	WorkspaceToolRequest
} from '$lib/types/sprocket';

type MutationClient = Pick<ConvexClient, 'mutation'>;

export type ViewerArgs = {
	guestId?: string;
};

export type WorkspaceSelectionResult = {
	_id: Id<'workspaceSessions'>;
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

export function launchAgentRun(args: {
	authToken?: string;
	desktopApi: DesktopApi;
	deploymentUrl: string;
	getViewerArgs: () => ViewerArgs;
	onError: (error: unknown) => void;
	runId: string;
	workspaceSessionId: Id<'workspaceSessions'>;
}) {
	void args.desktopApi
		.runAgent({
			deploymentUrl: args.deploymentUrl,
			...(args.authToken ? { authToken: args.authToken } : {}),
			...args.getViewerArgs(),
			runId: args.runId,
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

export async function syncAttachedWorkspaceSessions(args: {
	attachedWorkspaceSessionIds: Id<'workspaceSessions'>[];
	convexClient: MutationClient;
	executorClientId: string | null;
	getViewerArgs: () => ViewerArgs;
	workspaceSessionIds: Id<'workspaceSessions'>[];
}) {
	if (!args.executorClientId) {
		return;
	}

	const attachedSessionIds = [
		...new Set([...args.attachedWorkspaceSessionIds, ...args.workspaceSessionIds])
	];

	await args.convexClient.mutation(api.workspaceSessions.heartbeatAttached, {
		...args.getViewerArgs(),
		clientId: args.executorClientId,
		workspaceSessionIds: attachedSessionIds
	});
}

export async function attachWorkspaceSession(args: {
	attachedWorkspaceSessionIds: Id<'workspaceSessions'>[];
	convexClient: MutationClient;
	desktopApi: DesktopApi | null;
	executorClientId: string | null;
	getViewerArgs: () => ViewerArgs;
	refreshDesktopWorkspaceSessions: () => Promise<void>;
	workspaceSessionId: Id<'workspaceSessions'>;
}) {
	if (!args.desktopApi || !args.executorClientId) {
		return;
	}

	try {
		await args.desktopApi.getWorkspaceSessionOverview(args.workspaceSessionId);
		await args.refreshDesktopWorkspaceSessions();
		await syncAttachedWorkspaceSessions({
			attachedWorkspaceSessionIds: args.attachedWorkspaceSessionIds,
			convexClient: args.convexClient,
			executorClientId: args.executorClientId,
			getViewerArgs: args.getViewerArgs,
			workspaceSessionIds: [args.workspaceSessionId]
		});
	} catch (error) {
		await args.refreshDesktopWorkspaceSessions();
		throw error;
	}
}

function executorRequest(
	workspaceSessionId: Id<'workspaceSessions'>,
	request: Omit<WorkspaceToolRequest, 'workspaceSessionId'>
): WorkspaceToolRequest {
	return {
		...request,
		workspaceSessionId
	} as WorkspaceToolRequest;
}

function setProcessingJobForWorkspace(
	processingJobIdsByWorkspace: Record<string, Id<'executorJobs'>>,
	workspaceSessionId: Id<'workspaceSessions'>,
	jobId: Id<'executorJobs'> | null
) {
	if (jobId) {
		processingJobIdsByWorkspace[workspaceSessionId] = jobId;
		return;
	}

	delete processingJobIdsByWorkspace[workspaceSessionId];
}

export async function processExecutorJobs(
	desktopApi: DesktopApi | null,
	executorClientId: string | null,
	jobs: ExecutorJob[],
	processingJobIdsByWorkspace: Record<string, Id<'executorJobs'>>,
	convexClient: MutationClient,
	getViewerArgs: () => ViewerArgs,
	refreshDesktopWorkspaceSessions: () => Promise<void>
) {
	if (!desktopApi || !executorClientId) {
		return;
	}

	const jobsByWorkspace = groupExecutorJobsByWorkspace(jobs);

	for (const [workspaceSessionId, processingJobId] of Object.entries(
		processingJobIdsByWorkspace
	) as [Id<'workspaceSessions'>, Id<'executorJobs'>][]) {
		const workspaceJobs = jobsByWorkspace.get(workspaceSessionId) ?? [];
		if (workspaceJobs.some((job) => job._id === processingJobId)) {
			continue;
		}

		setProcessingJobForWorkspace(processingJobIdsByWorkspace, workspaceSessionId, null);
	}

	for (const [workspaceSessionId, workspaceJobs] of jobsByWorkspace) {
		if (processingJobIdsByWorkspace[workspaceSessionId]) {
			continue;
		}

		const nextJob = pickNextExecutorJobForWorkspace(workspaceJobs);
		if (!nextJob) {
			continue;
		}

		setProcessingJobForWorkspace(processingJobIdsByWorkspace, workspaceSessionId, nextJob._id);

		void (async () => {
			try {
				const claimedJob = (await convexClient.mutation(api.executor.claim, {
					...getViewerArgs(),
					jobId: nextJob._id,
					clientId: executorClientId
				})) as ExecutorJob | null;
				if (!claimedJob) {
					return;
				}

				const result = await desktopApi.executeWorkspaceTool(
					executorRequest(claimedJob.workspaceSessionId, {
						jobId: claimedJob._id,
						toolName: claimedJob.kind,
						payload: claimedJob.payload as WorkspaceToolRequest['payload']
					})
				);
				await convexClient.mutation(api.executor.complete, {
					...getViewerArgs(),
					jobId: claimedJob._id,
					result: result as NonNullable<ExecutorJob['result']>
				});
			} catch (error) {
				await refreshDesktopWorkspaceSessions();
				await convexClient.mutation(api.executor.fail, {
					...getViewerArgs(),
					jobId: nextJob._id,
					error: error instanceof Error ? error.message : 'Executor job failed.'
				});
			} finally {
				setProcessingJobForWorkspace(processingJobIdsByWorkspace, workspaceSessionId, null);
			}
		})();
	}
}
