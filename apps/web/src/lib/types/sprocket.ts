import type { Id } from '$convex/_generated/dataModel';
import type { Infer } from 'convex/values';
import {
	vExecutorJobKind,
	vExecutorJobResult,
	vExecutorJobStatus,
	vExecutorStatus,
	vModelId,
	vReasoningEffort,
	vRunStatus,
	vThreadMessageType
} from '$convex/lib/validators';

export type WorkspaceEntry = {
	name: string;
	kind: string;
};

export type LocalWorkspaceAvailability = 'available' | 'unavailable' | 'unlinked';

export type WorkspaceOverview = {
	rootPath: string;
	name: string;
	gitBranch: string | null;
	gitDirty: boolean;
	fileCount: number;
	directoryCount: number;
	topLevelEntries: WorkspaceEntry[];
	recentFiles: string[];
};

export type WorkspaceInstruction = {
	path: string;
	directory: string;
	contents: string;
	truncated: boolean;
};

export type FileReadOutput = {
	path: string;
	exists?: boolean;
	startLine: number;
	endLine: number;
	totalLines: number;
	truncated: boolean;
	contents: string;
	error?: string;
};

export type FileWriteOutput = {
	path: string;
	bytesWritten: number;
};

export type FileEditOutput = {
	path: string;
	replacements: number;
	bytesWritten: number;
};

export type WorkspaceToolName = Infer<typeof vExecutorJobKind>;

export type WorkspaceToolRequest =
	| {
			jobId?: string;
			workspaceSessionId: Id<'workspaceSessions'>;
			toolName: 'get_workspace_overview';
			payload: Record<string, never>;
	  }
	| {
			jobId?: string;
			workspaceSessionId: Id<'workspaceSessions'>;
			toolName: 'get_workspace_instructions';
			payload: Record<string, never>;
	  }
	| {
			jobId?: string;
			workspaceSessionId: Id<'workspaceSessions'>;
			toolName: 'read_file';
			payload: {
				path: string;
				startLine?: number;
				maxLines?: number;
			};
	  }
	| {
			jobId?: string;
			workspaceSessionId: Id<'workspaceSessions'>;
			toolName: 'create_file';
			payload: {
				path: string;
				content: string;
			};
	  }
	| {
			jobId?: string;
			workspaceSessionId: Id<'workspaceSessions'>;
			toolName: 'replace_in_file';
			payload: {
				path: string;
				oldText: string;
				newText: string;
				replaceAll?: boolean;
			};
	  };

export type WorkspaceToolResult =
	| WorkspaceOverview
	| WorkspaceInstruction[]
	| FileReadOutput
	| FileWriteOutput
	| FileEditOutput;

export type ExecutorJobPayload = WorkspaceToolRequest['payload'];

export type ExecutorJobResult = Infer<typeof vExecutorJobResult>;

export type WorkspaceSession = {
	_id: Id<'workspaceSessions'>;
	_creationTime?: number;
	userId: string;
	workspaceName: string;
	workspacePath?: string;
	executorStatus: Infer<typeof vExecutorStatus>;
	lastHeartbeatAt?: number;
	connectedClientId?: string;
	lastSeenAt: number;
	localWorkspaceAvailability?: LocalWorkspaceAvailability;
	localWorkspaceError?: string;
};

export type ThreadSummary = {
	_id: Id<'threadRecords'>;
	threadId: Id<'threadRecords'>;
	workspaceSessionId: Id<'workspaceSessions'>;
	workspaceName: string;
	title: string;
	selectedModel: Infer<typeof vModelId>;
	reasoningEffort: Infer<typeof vReasoningEffort>;
	lastMessageAt: number;
	threadStatus: 'active' | 'archived';
	latestRunStatus: RunState['status'] | null;
	latestRunStartedAt?: number;
	hasActiveRun: boolean;
};

export type WorkspaceThreadGroup = {
	key: string;
	workspaceName: string;
	workspacePath?: string;
	workspaceSessionId: Id<'workspaceSessions'>;
	executorStatus: WorkspaceSession['executorStatus'] | null;
	lastSeenAt: number;
	latestThreadAt: number;
	activeThreadCount: number;
	localWorkspaceAvailability?: LocalWorkspaceAvailability;
	localWorkspaceError?: string;
	threads: ThreadSummary[];
};

export type ExecutorJob = {
	_id: Id<'executorJobs'>;
	workspaceSessionId: Id<'workspaceSessions'>;
	threadId: Id<'threadRecords'>;
	runId: Id<'runs'>;
	kind: WorkspaceToolName;
	payload: ExecutorJobPayload;
	hidden?: boolean;
	status: Infer<typeof vExecutorJobStatus>;
	enqueuedAt: number;
	claimedAt?: number;
	completedAt?: number;
	result?: ExecutorJobResult;
	error?: string;
	sequence: number;
};

export type RunState = {
	_id: Id<'runs'>;
	threadId: Id<'threadRecords'>;
	userId: string;
	workspaceSessionId: Id<'workspaceSessions'>;
	status: Infer<typeof vRunStatus>;
	selectedModel: Infer<typeof vModelId>;
	reasoningEffort: Infer<typeof vReasoningEffort>;
	startedAt: number;
	completedAt?: number;
	lastError?: string;
	activeJobId?: Id<'executorJobs'>;
	promptMessageId?: Id<'threadMessages'>;
	jobs: ExecutorJob[];
};

export type ThreadMessage = {
	_id: Id<'threadMessages'>;
	_creationTime?: number;
	threadId: Id<'threadRecords'>;
	runId: Id<'runs'>;
	userId: string;
	type: Infer<typeof vThreadMessageType>;
	text: string;
	parts?: Array<
		| { type: 'text'; id: string; text: string }
		| { type: 'reasoning'; id: string; text: string }
		| { type: 'tool-call'; callId: string; name: string; input: unknown }
		| { type: 'tool-result'; callId: string; name?: string; output: unknown }
	>;
	runStatus: Infer<typeof vRunStatus>;
	runStartedAt: number;
	runCompletedAt?: number;
};

export type AgentRunRequest = {
	deploymentUrl: string;
	authToken?: string;
	guestId?: string;
	runId: string;
	workspaceSessionId: Id<'workspaceSessions'>;
};

export type DesktopApi = {
	chooseWorkspace: () => Promise<WorkspaceOverview | null>;
	listWorkspaceSessions: () => Promise<WorkspaceSessionLocation[]>;
	attachWorkspaceSession: (
		session: WorkspaceSessionAttachment
	) => Promise<WorkspaceSessionLocation>;
	getWorkspaceSessionOverview: (
		workspaceSessionId: Id<'workspaceSessions'>
	) => Promise<WorkspaceOverview>;
	executeWorkspaceTool: (request: WorkspaceToolRequest) => Promise<WorkspaceToolResult>;
	runAgent: (request: AgentRunRequest) => Promise<void>;
};

export type WorkspaceSessionAttachment = {
	workspaceSessionId: Id<'workspaceSessions'>;
	workspacePath: string;
};

export type WorkspaceSessionLocation = {
	workspaceSessionId: Id<'workspaceSessions'>;
	workspacePath: string;
	availability: Exclude<LocalWorkspaceAvailability, 'unlinked'>;
	lastValidatedAt: number;
	lastUsedAt: number;
	unavailableReason?: string;
};
