import type { Id } from '$convex/_generated/dataModel';
import type { SupportedModelId, SupportedReasoningEffort } from '$lib/models';

export type WorkspaceEntry = {
	name: string;
	kind: string;
};

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

export type WorkspaceToolName =
	| 'get_workspace_overview'
	| 'get_workspace_instructions'
	| 'read_file'
	| 'create_file'
	| 'replace_in_file';

export type WorkspaceToolRequest =
	| {
			jobId?: string;
			workspaceRoot: string;
			toolName: 'get_workspace_overview';
			payload: Record<string, never>;
	  }
	| {
			jobId?: string;
			workspaceRoot: string;
			toolName: 'get_workspace_instructions';
			payload: Record<string, never>;
	  }
	| {
			jobId?: string;
			workspaceRoot: string;
			toolName: 'read_file';
			payload: {
				path: string;
				startLine?: number;
				maxLines?: number;
			};
	  }
	| {
			jobId?: string;
			workspaceRoot: string;
			toolName: 'create_file';
			payload: {
				path: string;
				content: string;
			};
	  }
	| {
			jobId?: string;
			workspaceRoot: string;
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

export type ExecutorJobResult = WorkspaceToolResult;

export type WorkspaceSession = {
	_id: Id<'workspaceSessions'>;
	userId: string;
	workspacePath: string;
	workspaceName: string;
	workspaceOverview: WorkspaceOverview;
	gitBranch: string | null;
	gitDirty: boolean;
	executorStatus: 'connected' | 'disconnected';
	lastHeartbeatAt?: number;
	connectedClientId?: string;
	lastSeenAt: number;
};

export type ThreadSummary = {
	_id: Id<'threadRecords'>;
	threadId: string;
	workspaceSessionId: Id<'workspaceSessions'>;
	workspacePath: string;
	workspaceName: string;
	title: string;
	summary?: string;
	selectedModel: SupportedModelId;
	reasoningEffort: SupportedReasoningEffort;
	lastMessageAt: number;
	lastMessagePreview?: string;
	threadStatus: 'active' | 'archived';
	latestRunStatus: RunState['status'] | null;
	latestRunStartedAt?: number;
	hasActiveRun: boolean;
};

export type WorkspaceThreadGroup = {
	key: string;
	workspaceName: string;
	workspacePath: string;
	workspaceSessionId: Id<'workspaceSessions'>;
	gitBranch: string | null;
	gitDirty: boolean;
	executorStatus: WorkspaceSession['executorStatus'] | null;
	lastSeenAt: number;
	latestThreadAt: number;
	activeThreadCount: number;
	threads: ThreadSummary[];
};

export type ExecutorJob = {
	_id: Id<'executorJobs'>;
	workspaceSessionId: Id<'workspaceSessions'>;
	threadId: string;
	runId: Id<'runs'>;
	kind: WorkspaceToolName;
	payload: ExecutorJobPayload;
	hidden?: boolean;
	status: 'pending' | 'claimed' | 'completed' | 'failed' | 'cancelled';
	enqueuedAt: number;
	claimedBy?: string;
	claimedAt?: number;
	completedAt?: number;
	result?: ExecutorJobResult;
	error?: string;
	sequence: number;
};

export type RunState = {
	_id: Id<'runs'>;
	threadId: string;
	userId: string;
	workspaceSessionId: Id<'workspaceSessions'>;
	status: 'queued' | 'running' | 'awaiting_executor' | 'completed' | 'failed' | 'cancelled';
	selectedModel: SupportedModelId;
	reasoningEffort: SupportedReasoningEffort;
	startedAt: number;
	completedAt?: number;
	lastError?: string;
	activeJobId?: Id<'executorJobs'>;
	promptMessageId?: Id<'threadMessage'>;
	jobs: ExecutorJob[];
};

export type ThreadMessage = {
	_id: Id<'threadMessage'>;
	threadId: string;
	runId?: Id<'runs'>;
	role: 'user' | 'assistant';
	status: 'pending' | 'streaming' | 'success' | 'failed';
	text: string;
	order: number;
	stepOrder: number;
	agentName?: string;
	createdAt: number;
	completedAt?: number;
};

export type AgentRunRequest = {
	deploymentUrl: string;
	authToken?: string;
	guestId?: string;
	runId: string;
};

export type DesktopApi = {
	chooseWorkspace: () => Promise<string | null>;
	executeWorkspaceTool: (request: WorkspaceToolRequest) => Promise<WorkspaceToolResult>;
	runAgent: (request: AgentRunRequest) => Promise<void>;
};
