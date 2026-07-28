import type { Id } from '$convex/_generated/dataModel';
import type { AssistantPart } from '$convex/lib/assistantParts';
import type { Infer } from 'convex/values';
import {
	vExecutorJobKind,
	vExecutorJobStatus,
	vExecutorStatus,
	vModelId,
	vReasoningEffort,
	vServiceTier,
	vRunStatus,
	vThreadMessageType,
	type ExecutorJobPayload,
	type ExecutorJobResult,
	type WorkspaceInstruction
} from '$convex/lib/validators';

export type LocalAttachmentAvailability = 'available' | 'unavailable' | 'unlinked';

export type { WorkspaceInstruction, ExecutorJobPayload, ExecutorJobResult };

export type AgentToolName = Infer<typeof vExecutorJobKind>;

export type Project = {
	_id: Id<'projects'>;
	_creationTime?: number;
	userId: string;
	repositoryKey: string;
	displayName: string;
	workspacePath?: string;
	executorStatus: Infer<typeof vExecutorStatus>;
	lastHeartbeatAt?: number;
	connectedClientId?: string;
	lastSeenAt: number;
	localAttachmentAvailability?: LocalAttachmentAvailability;
	localAttachmentError?: string;
};

export type ThreadSummary = {
	threadId: Id<'threadRecords'>;
	projectId: Id<'projects'>;
	title: string;
	selectedModel: Infer<typeof vModelId>;
	reasoningEffort: Infer<typeof vReasoningEffort>;
	serviceTier: Infer<typeof vServiceTier>;
	lastMessageAt: number;
	threadStatus: 'active' | 'archived';
	latestRunStatus: RunState['status'] | null;
	latestRunId: Id<'runs'> | null;
	latestRunStartedAt?: number;
	latestRunClaimExpiresAt?: number;
	hasActiveRun: boolean;
};

export type ProjectThreadGroup = {
	project: Project;
	threads: ThreadSummary[];
	latestThreadAt: number;
	activeThreadCount: number;
};

export type ExecutorJob = {
	_id: Id<'executorJobs'>;
	projectId: Id<'projects'>;
	threadId: Id<'threadRecords'>;
	runId: Id<'runs'>;
	kind: AgentToolName;
	callId?: string;
	payload: ExecutorJobPayload;
	hidden: boolean;
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
	projectId: Id<'projects'>;
	status: Infer<typeof vRunStatus>;
	submissionId: string;
	claimExpiresAt?: number;
	selectedModel: Infer<typeof vModelId>;
	reasoningEffort: Infer<typeof vReasoningEffort>;
	serviceTier: Infer<typeof vServiceTier>;
	startedAt: number;
	completedAt?: number;
	lastError?: string;
	activeJobId?: Id<'executorJobs'>;
	promptMessageId?: Id<'threadMessages'>;
	jobs: ExecutorJob[];
};

export type MessageAttachment = {
	imageUploadId: Id<'imageUploads'>;
	name: string;
	mediaType: string;
	size: number;
	url: string | null;
};

export type ThreadMessage = {
	_id: Id<'threadMessages'>;
	_creationTime?: number;
	threadId: Id<'threadRecords'>;
	runId: Id<'runs'>;
	userId: string;
	type: Infer<typeof vThreadMessageType>;
	text: string;
	attachments: MessageAttachment[];
	parts: AssistantPart[];
	runStatus: Infer<typeof vRunStatus>;
	runStartedAt: number;
	runCompletedAt?: number;
};

export type AgentRunRequest = {
	authToken: string;
	submissionId: string;
	threadId: Id<'threadRecords'>;
	prompt: string;
	imageUploadIds: Id<'imageUploads'>[];
	selectedModel: Infer<typeof vModelId>;
	reasoningEffort: Infer<typeof vReasoningEffort>;
	serviceTier: Infer<typeof vServiceTier>;
	projectId: Id<'projects'>;
};

export type AgentRunStart = {
	runId: Id<'runs'>;
};

export type FilesystemBrowseEntry = {
	name: string;
	fullPath: string;
};

export type FilesystemBrowseResult = {
	parentPath: string;
	entries: FilesystemBrowseEntry[];
};

export type SkillSummary = {
	name: string;
	description: string;
};

export type WorkspaceSkillsResult = {
	skills: SkillSummary[];
	warnings: string[];
};

export type DesktopApi = {
	browseFilesystem: (input: {
		partialPath: string;
		cwd?: string;
	}) => Promise<FilesystemBrowseResult>;
	listWorkspaceSkills: (input: { workspacePath: string }) => Promise<WorkspaceSkillsResult>;
	resolveWorkspacePath: (input: {
		workspacePath: string;
		createIfMissing?: boolean;
	}) => Promise<WorkspacePathResolution>;
	listProjectAttachments: () => Promise<ProjectAttachment[]>;
	attachProject: (attachment: ProjectAttachmentRequest) => Promise<ProjectAttachment>;
	runAgent: (request: AgentRunRequest) => Promise<AgentRunStart>;
};

export type WorkspacePathResolution = {
	workspacePath: string;
	displayName: string;
	repositoryKey: string;
};

export type ProjectAttachmentRequest = {
	projectId: Id<'projects'>;
	workspacePath: string;
};

export type ProjectAttachment = {
	projectId: Id<'projects'>;
	workspacePath: string;
	availability: Exclude<LocalAttachmentAvailability, 'unlinked'>;
	lastValidatedAt: number;
	lastUsedAt: number;
	unavailableReason?: string;
};
