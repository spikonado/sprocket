import type { Doc, Id } from '$convex/_generated/dataModel';
import type { AssistantPart } from '$convex/lib/assistantParts';
import type { Infer } from 'convex/values';
import {
	vExecutorJobKind,
	vExecutorJobStatus,
	vRunStatus,
	type ExecutorJobPayload,
	type ExecutorJobResult,
	type WorkspaceInstruction
} from '$convex/lib/validators';

export type LocalAttachmentAvailability = 'available' | 'unavailable';

export type { WorkspaceInstruction, ExecutorJobPayload, ExecutorJobResult };

export type AgentToolName = Infer<typeof vExecutorJobKind>;

export type Project = {
	repositoryKey: string;
	displayName: string;
	workspacePath: string;
	localAttachmentAvailability?: LocalAttachmentAvailability;
	localAttachmentError?: string;
};

export type ThreadSummary = {
	threadId: Id<'threadRecords'>;
	repositoryKey: string;
	title: string;
	selectedModel: string;
	reasoningEffort: string;
	serviceTier: string;
	lastMessageAt: number;
	threadStatus: 'active' | 'archived';
	status: RunState['status'];
};

export type ProjectThreadGroup = {
	project: Project;
	threads: ThreadSummary[];
	activeThreadCount: number;
};

export type ExecutorJob = {
	_id: Id<'executorJobs'>;
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
	status: Infer<typeof vRunStatus>;
	submissionId: string;
	claimExpiresAt?: number;
	selectedModel: string;
	reasoningEffort: string;
	serviceTier: string;
	startedAt: number;
	completedAt?: number;
	lastError?: string;
	activeJobId?: Id<'executorJobs'>;
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
	_id: string;
	_creationTime?: number;
	threadId: Id<'threadRecords'>;
	runId: Id<'runs'>;
	userId: string;
	type: 'prompt' | 'response';
	text: string;
	attachments: MessageAttachment[];
	parts: AssistantPart[];
	runStatus: Infer<typeof vRunStatus>;
	runStartedAt: number;
	runCompletedAt?: number;
	sourceNumbers?: number[];
	streamIds?: string[];
	detailsLoaded?: boolean;
};

export type AgentRunRequest = {
	userId: string;
	submissionId: string;
	threadId?: Id<'threadRecords'>;
	repositoryKey?: string;
	prompt: string;
	imageUploadIds: Id<'imageUploads'>[];
	selectedModel: string;
	reasoningEffort: string;
	serviceTier: string;
	workspacePath: string;
	continuationOfRunId?: Id<'runs'>;
};

export type AgentRunStart = {
	runId: Id<'runs'>;
	threadId: Id<'threadRecords'>;
};

export type LocalTranscriptAttachment = {
	imageUploadId: Id<'imageUploads'>;
	name: string;
	mediaType: string;
	size: number;
	storageId: string;
	url?: string;
};

export type LocalTranscriptPage = {
	threadId: Id<'threadRecords'>;
	totalParts: number;
	historyFromNumber: number;
	stale: boolean;
	messages: ThreadMessage[];
	nextBefore?: number;
};

export type LiveCompletionOverlay = {
	threadId: Id<'threadRecords'>;
	runId: Id<'runs'>;
	runStatus: Infer<typeof vRunStatus>;
	streamId?: string;
	text: string;
	parts: AssistantPart[];
	runStartedAt: number;
};

export type TranscriptWatchEvent = {
	eventType: string;
	totalParts?: number;
	stale: boolean;
};

export type ThreadCacheStatus = 'loading' | 'live' | 'reconnecting' | 'offline' | 'error';

export type ThreadCacheWatchEvent = {
	status: ThreadCacheStatus;
	lastSyncedAt: number | null;
};

export type ThreadCacheSnapshot = ThreadCacheWatchEvent & {
	threads: Doc<'threadRecords'>[];
};

export type ThreadCacheUserRequest = {
	userId: string;
	selectedThreadId?: Id<'threadRecords'>;
};

export type LiveCompletionWatchEvent =
	{ eventType: 'updated'; live: LiveCompletionOverlay } | { eventType: 'cleared' };

export type TranscriptUploadRequest = {
	userId: string;
	name: string;
	file: File;
	threadId?: Id<'threadRecords'>;
};

export type TranscriptUploadResult =
	| {
			imageUploadId: Id<'imageUploads'>;
			name: string;
			mediaType: string;
			size: number;
			url: string;
	  }
	| { error: string };

export type TranscriptDiscardRequest = {
	userId: string;
	imageUploadId: Id<'imageUploads'>;
	threadId?: Id<'threadRecords'>;
};

export type TranscriptScopeRequest = {
	userId: string;
	threadId: Id<'threadRecords'>;
};

export type TranscriptPageRequest = {
	userId: string;
	threadId: Id<'threadRecords'>;
	before?: number;
	limit?: number;
};

export type TranscriptDetailsRequest = TranscriptScopeRequest & { numbers: number[] };

export type FilesystemBrowseEntry = {
	name: string;
	fullPath: string;
};

export type FilesystemBrowseResult = {
	parentPath: string;
	entries: FilesystemBrowseEntry[];
	volumeList?: boolean;
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
	fetchTranscriptPage: (request: TranscriptPageRequest) => Promise<LocalTranscriptPage>;
	fetchTranscriptDetails: (request: TranscriptDetailsRequest) => Promise<ThreadMessage>;
	watchTranscript: (
		request: TranscriptScopeRequest,
		handlers: {
			onEvent: (event: TranscriptWatchEvent) => void;
			signal: AbortSignal;
		}
	) => Promise<void>;
	watchLiveCompletion: (
		request: TranscriptScopeRequest,
		handlers: {
			onEvent: (event: LiveCompletionWatchEvent) => void;
			signal: AbortSignal;
		}
	) => Promise<void>;
	clearTranscriptReplica: (request: TranscriptScopeRequest) => Promise<void>;
	fetchTranscriptAttachment: (
		request: TranscriptScopeRequest & { imageUploadId: Id<'imageUploads'> }
	) => Promise<Blob | null>;
	uploadTranscriptAttachment: (request: TranscriptUploadRequest) => Promise<TranscriptUploadResult>;
	discardTranscriptAttachment: (request: TranscriptDiscardRequest) => Promise<boolean>;
	registerThreadCache: (request: ThreadCacheUserRequest) => Promise<ThreadCacheWatchEvent>;
	fetchThreadSnapshot: (request: ThreadCacheUserRequest) => Promise<ThreadCacheSnapshot>;
	watchThreadCache: (
		request: ThreadCacheUserRequest,
		handlers: {
			onEvent: (event: ThreadCacheWatchEvent) => void;
			signal: AbortSignal;
		}
	) => Promise<void>;
	renameThread: (request: ThreadCommandRequest & { title: string }) => Promise<boolean>;
	archiveThread: (request: ThreadCommandRequest) => Promise<boolean>;
	restoreThread: (request: ThreadCommandRequest) => Promise<boolean>;
	rekeyRepository: (
		request: ThreadCacheUserRequest & { from: string; to: string }
	) => Promise<number>;
	requestRunCancellation: (
		request: ThreadCacheUserRequest & { runId: Id<'runs'> }
	) => Promise<void>;
	endAccountSession: (request: ThreadCacheUserRequest) => Promise<void>;
};

export type ThreadCommandRequest = ThreadCacheUserRequest & {
	threadId: Id<'threadRecords'>;
};

export type WorkspacePathResolution = {
	workspacePath: string;
	displayName: string;
	repositoryKey: string;
};

export type ProjectAttachmentRequest = {
	workspacePath: string;
	replaceWorkspacePath?: string;
};

export type ProjectAttachment = {
	workspacePath: string;
	repositoryKey: string;
	displayName: string;
	availability: LocalAttachmentAvailability;
	lastValidatedAt: number;
	lastUsedAt: number;
	unavailableReason?: string;
	previousRepositoryKey?: string;
};
