import type { Id } from '$convex/_generated/dataModel';
import type { Infer } from 'convex/values';
import {
	vExecutorJobKind,
	vExecutorJobPayload,
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

export type WorkspaceToolName = Infer<typeof vExecutorJobKind>;

export type ExecutorJobPayload = Infer<typeof vExecutorJobPayload>;

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
	authToken?: string;
	guestId?: string;
	threadId: Id<'threadRecords'>;
	prompt: string;
	selectedModel: Infer<typeof vModelId>;
	reasoningEffort: Infer<typeof vReasoningEffort>;
	workspaceSessionId: Id<'workspaceSessions'>;
};

export type LocalIdentity = {
	guestId: string;
};

export type FilesystemBrowseEntry = {
	name: string;
	fullPath: string;
};

export type FilesystemBrowseResult = {
	parentPath: string;
	entries: FilesystemBrowseEntry[];
};

export type DesktopApi = {
	getLocalIdentity: () => Promise<LocalIdentity>;
	browseFilesystem: (input: {
		partialPath: string;
		cwd?: string;
	}) => Promise<FilesystemBrowseResult>;
	workspaceOverviewForPath: (input: {
		workspacePath: string;
		createIfMissing?: boolean;
	}) => Promise<WorkspaceOverview>;
	listWorkspaceSessions: () => Promise<WorkspaceSessionLocation[]>;
	attachWorkspaceSession: (
		session: WorkspaceSessionAttachment
	) => Promise<WorkspaceSessionLocation>;
	getWorkspaceSessionOverview: (
		workspaceSessionId: Id<'workspaceSessions'>
	) => Promise<WorkspaceOverview>;
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
