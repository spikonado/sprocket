import type { Doc, Id } from '$convex/_generated/dataModel';
import type { AssistantPart } from '$convex/lib/assistantParts';
import type { Infer } from 'convex/values';
import type { displayRowValidator } from '$convex/lib/transcriptDisplayTypes';
import {
	vExecutorJobKind,
	vExecutorJobStatus,
	vRunStatus,
	type ArtifactType,
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
	fastMode: boolean;
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
	fastMode: boolean;
	startedAt: number;
	completedAt?: number;
	lastError?: string;
	activeJobId?: Id<'executorJobs'>;
	jobs: ExecutorJob[];
};

export type MessageAttachment = {
	storageId: Id<'_storage'>;
	name: string;
	mediaType: string;
	size: number;
	url: string | null;
};

export type ThreadMessage = {
	displayRow?: TranscriptDisplayRow;
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
	storageIds: Id<'_storage'>[];
	selectedModel: string;
	reasoningEffort: string;
	fastMode: boolean;
	workspacePath: string;
	continuationOfRunId?: Id<'runs'>;
};

export type AgentRunStart = {
	runId: Id<'runs'>;
	threadId: Id<'threadRecords'>;
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
			storageId: Id<'_storage'>;
			name: string;
			mediaType: string;
			size: number;
			url: string;
	  }
	| { error: string };

export type TranscriptDiscardRequest = {
	userId: string;
	storageId: Id<'_storage'>;
	threadId?: Id<'threadRecords'>;
};

export type TranscriptScopeRequest = {
	userId: string;
	threadId: Id<'threadRecords'>;
};

export type TranscriptDisplayRow = Infer<typeof displayRowValidator>;
export type TranscriptDisplayPage = {
	replicaId: string;
	rows: TranscriptDisplayRow[];
	indexing: boolean;
	stale: boolean;
	nextBefore?: number;
	endSequence: number;
	revision: number;
	persistedStreams: TranscriptDisplayStream[];
	changes: Array<{ id: TranscriptDisplayRow['id']; row: TranscriptDisplayRow | null }>;
	changesCursor: TranscriptChangeCursor;
	moreChanges: boolean;
};
export type TranscriptChangeCursor = { revision: number; sequence: number };
export type TranscriptDisplayStream = { runId: Id<'runs'>; streamId: string };
export type TranscriptDisplayRequest = TranscriptScopeRequest & {
	before?: number;
	limit?: number;
	streams?: TranscriptDisplayStream[];
	changesAfter?: TranscriptChangeCursor;
};
export type TranscriptDisplayDetails = {
	parts: AssistantPart[];
	indexing: boolean;
	nextAfter?: number;
	previousBefore?: number;
	revision: number;
	stale: boolean;
};
export type TranscriptDetailCursor = { after?: number; before?: number; latest?: boolean };
export type TranscriptDisplayDetailsRequest = TranscriptScopeRequest &
	TranscriptDetailCursor & { rowId: TranscriptDisplayRow['id']; limit?: number };

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

export type ArtifactScope = 'thread' | 'project';

/** Local file-backed artifact snapshot from POST /api/artifacts/watch. */
export type LocalArtifact = {
	_id: string;
	userId: string;
	scope: ArtifactScope;
	repositoryKey: string;
	/** Present only for thread-scoped artifacts. */
	threadId?: string;
	localPath?: string;
	content: string;
	type: ArtifactType;
	title: string;
	revision: number;
	createdAt: number;
	updatedAt: number;
	localError?: string;
};

export type ArtifactsWatchRequest = {
	userId: string;
	repositoryKey: string;
	workspacePath: string;
	threadId?: string;
};

export type ArtifactsWatchEvent = {
	artifacts: LocalArtifact[];
	stale: boolean;
	error?: string;
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
	fetchTranscriptDisplay: (
		request: TranscriptDisplayRequest,
		signal?: AbortSignal
	) => Promise<TranscriptDisplayPage>;
	fetchTranscriptDisplayDetails: (
		request: TranscriptDisplayDetailsRequest,
		signal?: AbortSignal
	) => Promise<TranscriptDisplayDetails>;
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
		request: TranscriptScopeRequest & { storageId: Id<'_storage'> }
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
	watchArtifacts: (
		request: ArtifactsWatchRequest,
		handlers: {
			onEvent: (event: ArtifactsWatchEvent) => void;
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
