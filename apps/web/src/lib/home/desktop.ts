import { api } from '$convex/_generated/api';
import type { Id } from '$convex/_generated/dataModel';
import type { ConvexClient } from 'convex/browser';
import type {
	AgentRunRequest,
	DesktopApi,
	LocalWorkspaceAvailability,
	WorkspaceSession,
	WorkspaceSessionAttachment,
	WorkspaceSessionLocation
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
	getViewerArgs: () => ViewerArgs;
	onError: (error: unknown) => void;
	threadId: Id<'threadRecords'>;
	prompt: string;
	selectedModel: AgentRunRequest['selectedModel'];
	reasoningEffort: AgentRunRequest['reasoningEffort'];
	workspaceSessionId: Id<'workspaceSessions'>;
}) {
	void args.desktopApi
		.runAgent({
			...(args.authToken ? { authToken: args.authToken } : {}),
			...args.getViewerArgs(),
			threadId: args.threadId,
			prompt: args.prompt,
			selectedModel: args.selectedModel,
			reasoningEffort: args.reasoningEffort,
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
