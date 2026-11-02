import type { Id } from '@convex/_generated/dataModel';
import type { AssistantPart } from '@convex/lib/assistantParts';
import type { Infer } from 'convex/values';
import type { displayRowValidator } from '@convex/lib/transcriptDisplayTypes';
import {
	vExecutorJobKind,
	vExecutorJobStatus,
	vRunStatus,
	type ArtifactType,
	type ExecutorJobPayload,
	type ExecutorJobResult,
	type LinkedPullRequest,
	type WorkspaceInstruction
} from '@convex/lib/validators';

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
	completionProvider?: 'spikonado' | 'openai' | 'chatgpt';
	reasoningEffort: string;
	fastMode: boolean;
	lastMessageAt: number;
	threadStatus: 'active' | 'archived';
	status: RunState['status'];
};

export type ExecutorJob = {
	_id: Id<'executorJobs'>;
	threadId: Id<'threadRecords'>;
	runId: Id<'runs'>;
	kind: AgentToolName;
	callId?: string;
	payload: ExecutorJobPayload;
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
	completionProvider?: 'spikonado' | 'openai' | 'chatgpt';
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

export type LiveTranscriptMessage = Omit<LiveCompletionOverlay, 'streamId'> & {
	kind: 'live';
	id: string;
};

export type TranscriptMessage = TranscriptDisplayRow | LiveTranscriptMessage;

export type AgentRunRequest = {
	userId: string;
	submissionId: string;
	threadId?: Id<'threadRecords'>;
	repositoryKey?: string;
	prompt: string;
	storageIds: Id<'_storage'>[];
	selectedModel: string;
	completionProvider?: 'spikonado' | 'openai' | 'chatgpt';
	reasoningEffort: string;
	fastMode: boolean;
	workspacePath: string;
	continuationOfRunId?: Id<'runs'>;
};

export type AgentRunStart = {
	runId: Id<'runs'>;
	threadId: Id<'threadRecords'>;
	/** The run was stopped before it began, so its prompt was never written. */
	stopped: boolean;
};

export type LiveCompletionOverlay = {
	threadId: Id<'threadRecords'>;
	runId: Id<'runs'>;
	runStatus: Infer<typeof vRunStatus>;
	streamId: string;
	text: string;
	parts: AssistantPart[];
};

export type TranscriptWatchEvent = {
	eventType: string;
	totalParts?: number;
	stale: boolean;
};

export type LocalUserRequest = {
	userId: string;
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
	syncing: boolean;
	stale: boolean;
	nextBefore?: number;
	revision: number;
	persistedStreams: TranscriptDisplayStream[];
	changes: Array<{ id: TranscriptDisplayRow['id']; row: TranscriptDisplayRow | null }>;
	changesCursor: TranscriptChangeCursor;
	moreChanges: boolean;
};

export type TranscriptChangeCursor = { revision: number; position: number };

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
	disableModelInvocation: boolean;
};

export type WorkspaceSkillsResult = {
	skills: SkillSummary[];
	warnings: string[];
};

/** Local file-backed artifact snapshot from the `artifacts` live-update topic. */
export type LocalArtifact = {
	_id: string;
	userId: string;
	repositoryKey: string;
	localPath?: string;
	content: string;
	type: ArtifactType;
	title: string;
	revision: number;
	updatedAt: number;
	localError?: string;
};

export type ArtifactsWatchRequest = {
	userId: string;
	repositoryKey: string;
	workspacePath: string;
};

export type ArtifactsWatchEvent = {
	artifacts: LocalArtifact[];
	stale: boolean;
	error?: string;
};

export type ChatGptAccount = {
	connectionId: string;
	label: string;
	connected: boolean;
};

export type ChatGptStatus = {
	accounts: ChatGptAccount[];
	activeConnectionId: string | null;
	loginAvailable: boolean;
	error?: string;
};

export type ChatGptBrowserLoginStart = {
	state: string;
	authorizeUrl: string;
};

export type GitHubHostStatus = {
	host: string;
	enabled: boolean;
	hasSavedToken: boolean;
	source: 'settings' | 'environment' | 'gitHubCli' | null;
	login: string | null;
	problem: string | null;
};

export type GitHubStatus = {
	enabled: boolean;
	cliVersion: string | null;
	savedTokensProblem: string | null;
	hosts: GitHubHostStatus[];
};

/** One switch on this machine at a time. Tokens are saved through Convex. */
export type GitHubSettingsUpdate = {
	enabled?: boolean;
	host?: { host: string; enabled: boolean };
};

/** A connector on this machine. Install also updates and retries. */
export type ConnectorStatus = {
	id: 'kicad';
	name: string;
	state: 'notInstalled' | 'installing' | 'failed' | 'installed';
	error: string | null;
	updateAvailable: boolean;
};

export type ChatGptBrowserLoginResult = {
	status: 'pending' | 'complete' | 'error';
	error?: string;
};

export type WorkspaceSearchEntry = {
	path: string;
	kind: 'file' | 'directory';
};

export type WorkspaceSearchResult = {
	entries: WorkspaceSearchEntry[];
	scanning: boolean;
};

export type WorkspaceGitStatus =
	'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'ignored';

/** Directory paths end with `/`. */
export type WorkspaceFilesResult = {
	paths: string[];
	gitStatus: { path: string; status: WorkspaceGitStatus }[];
	scanning: boolean;
	truncated: boolean;
};

export type WorkspaceFileContent = {
	content: string | null;
	version: string;
	size: number;
	unsupported: 'binary' | 'tooLarge' | null;
};

/** Sent when what's on disk changes; the first event is the current state. */
export type DiskEvent<T> = ({ kind: 'snapshot' } & T) | { kind: 'error'; message: string };

export type WatchHandlers<T> = { onEvent: (event: T) => void; signal: AbortSignal };

export type WorkspaceFileWriteResult = { status: 'saved' | 'conflict'; version: string };

export type WorkspaceFileTarget = { workspacePath: string; path: string };

export type RunningCommand = {
	sessionId: string;
	command: string;
	workdir: string;
	startedAt: number;
};

export type BrowserStatus = {
	state: 'installing' | 'ready' | 'error';
	error: string | null;
};

export type LocalApi = {
	startBrowser: (signal?: AbortSignal) => Promise<BrowserStatus>;
	browserDashboardUrl: string;
	watchBrowserStatus: (handlers: WatchHandlers<BrowserStatus>) => Promise<void>;
	watchRunningCommands: (
		request: TranscriptScopeRequest,
		handlers: WatchHandlers<RunningCommand[]>
	) => Promise<void>;
	terminateCommand: (
		request: TranscriptScopeRequest & { sessionId: string }
	) => Promise<{ terminated: boolean }>;
	browseFilesystem: (input: {
		partialPath: string;
		cwd?: string;
	}) => Promise<FilesystemBrowseResult>;
	listWorkspaceSkills: (input: { workspacePath: string }) => Promise<WorkspaceSkillsResult>;
	searchWorkspace: (
		input: { workspacePath: string; query: string },
		signal?: AbortSignal
	) => Promise<WorkspaceSearchResult>;
	watchWorkspaceFiles: (
		input: { workspacePath: string },
		handlers: WatchHandlers<DiskEvent<WorkspaceFilesResult>>
	) => Promise<void>;
	workspaceEntryKind: (
		input: WorkspaceFileTarget,
		signal?: AbortSignal
	) => Promise<'file' | 'directory'>;
	watchWorkspaceFile: (
		input: WorkspaceFileTarget,
		handlers: WatchHandlers<DiskEvent<WorkspaceFileContent>>
	) => Promise<void>;
	/** Reads a whole text file, past the editor's size limit, with the version its watch reports. */
	readWorkspaceText: (
		input: WorkspaceFileTarget,
		signal?: AbortSignal
	) => Promise<{ content: string; version: string }>;
	writeWorkspaceFile: (
		input: WorkspaceFileTarget & { content: string; expectedVersion: string | null }
	) => Promise<WorkspaceFileWriteResult>;
	createWorkspaceFile: (input: WorkspaceFileTarget & { directory: boolean }) => Promise<void>;
	renameWorkspaceFile: (input: {
		workspacePath: string;
		from: string;
		to: string;
	}) => Promise<void>;
	deleteWorkspaceFile: (input: WorkspaceFileTarget) => Promise<void>;
	resolveWorkspacePath: (input: {
		workspacePath: string;
		createIfMissing?: boolean;
	}) => Promise<WorkspacePathResolution>;
	listProjectAttachments: () => Promise<ProjectAttachment[]>;
	attachProject: (attachment: ProjectAttachmentRequest) => Promise<ProjectAttachment>;
	removeProject: (input: { workspacePath: string }) => Promise<void>;
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
		handlers: WatchHandlers<TranscriptWatchEvent>
	) => Promise<void>;
	watchLiveCompletion: (
		request: TranscriptScopeRequest,
		handlers: WatchHandlers<LiveCompletionWatchEvent>
	) => Promise<void>;
	clearTranscriptReplica: (request: TranscriptScopeRequest) => Promise<void>;
	fetchTranscriptAttachment: (
		request: TranscriptScopeRequest & { storageId: Id<'_storage'> }
	) => Promise<Blob | null>;
	uploadTranscriptAttachment: (request: TranscriptUploadRequest) => Promise<TranscriptUploadResult>;
	discardTranscriptAttachment: (request: TranscriptDiscardRequest) => Promise<boolean>;
	deleteArtifact: (request: ArtifactsWatchRequest & { artifactId: string }) => Promise<void>;
	watchArtifacts: (
		request: ArtifactsWatchRequest,
		handlers: WatchHandlers<ArtifactsWatchEvent>
	) => Promise<void>;
	requestRunCancellation: (request: LocalUserRequest & { runId: Id<'runs'> }) => Promise<void>;
	fetchPullRequestStates: (
		request: LocalUserRequest & {
			pullRequests: Pick<LinkedPullRequest, 'repository' | 'number'>[];
		}
	) => Promise<LinkedPullRequest[]>;
	startAccountSession: (request: LocalUserRequest) => Promise<void>;
	endAccountSession: (request: LocalUserRequest) => Promise<void>;
	fetchChatGptStatus: (request: LocalUserRequest) => Promise<ChatGptStatus>;
	startChatGptBrowserLogin: (
		request: LocalUserRequest & { connectionId?: string }
	) => Promise<ChatGptBrowserLoginStart>;
	fetchChatGptBrowserLoginResult: (
		request: LocalUserRequest & { state: string }
	) => Promise<ChatGptBrowserLoginResult>;
	cancelChatGptBrowserLogin: (request: LocalUserRequest & { state: string }) => Promise<void>;
	selectChatGptAccount: (request: LocalUserRequest & { connectionId: string }) => Promise<void>;
	disconnectChatGptAccount: (
		request: LocalUserRequest & { connectionId: string }
	) => Promise<string | null>;
	fetchGitHubStatus: (userId: string) => Promise<GitHubStatus>;
	updateGitHubSettings: (userId: string, update: GitHubSettingsUpdate) => Promise<GitHubStatus>;
	fetchConnectors: (userId: string) => Promise<ConnectorStatus[]>;
	installConnector: (userId: string, id: ConnectorStatus['id']) => Promise<ConnectorStatus>;
	uninstallConnector: (userId: string, id: ConnectorStatus['id']) => Promise<ConnectorStatus>;
};

export type WorkspacePathResolution = {
	workspacePath: string;
	displayName: string;
	repositoryKey: string;
	attachmentKey: string;
};

export type ProjectAttachmentRequest = {
	workspacePath: string;
	replaceWorkspacePath?: string;
};

export type ProjectAttachment = {
	workspacePath: string;
	repositoryKey: string;
	attachmentKey: string;
	displayName: string;
	availability: LocalAttachmentAvailability;
	lastValidatedAt: number;
	lastUsedAt: number;
	lastMessageSentAt?: number;
	unavailableReason?: string;
};
