import type { Id } from '@convex/_generated/dataModel';
import type { Infer } from 'convex/values';
import {
	vRunStatus,
	type LinkedPullRequest,
	type WorkspaceInstruction
} from '@convex/lib/validators';

export type LocalAttachmentAvailability = 'available' | 'unavailable';

export type { WorkspaceInstruction };

export type RunStatus = Infer<typeof vRunStatus>;

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
	status: RunStatus;
};

export type MessageAttachment = {
	storageId: Id<'_storage'>;
	name: string;
	mediaType: string;
	size: number;
	url: string | null;
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

export type LocalUserRequest = {
	userId: string;
};

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

export type TranscriptAttachment = Omit<MessageAttachment, 'url'> & { url?: string };

export type TranscriptRow = { id: string; runId: string } & (
	| { kind: 'prompt'; text: string; attachments: TranscriptAttachment[] }
	| { kind: 'text'; text: string; running: boolean }
	| { kind: 'work'; toolCounts: Record<string, number>; running: boolean }
	| { kind: 'reasoning'; label: string; running: boolean; text?: string }
	| {
			kind: 'tool';
			name: string;
			label?: string;
			summary: string;
			commands?: { start: number; text: string }[];
			hasMore: boolean;
			status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
			error?: string;
			action?:
				| { kind: 'openFile'; path: string }
				| { kind: 'openUrl'; url: string }
				| { kind: 'saveCard' };
	  }
);

export type TranscriptSnapshot = {
	type: 'snapshot';
	rows: TranscriptRow[];
	nextBefore: number | null;
	stale: boolean;
};

export type TranscriptEvent =
	| TranscriptSnapshot
	| { type: 'downloading' }
	| {
			type: 'batch';
			updates: Array<
				| { type: 'row'; row: TranscriptRow }
				| { type: 'append'; rowId: string; offset: number; text: string }
			>;
	  };

export type TranscriptRowsRequest = TranscriptScopeRequest & {
	before: number;
};

export type TranscriptRowRequest = TranscriptScopeRequest & { rowId: string };

export type TranscriptWorkRequest = TranscriptRowRequest & { before?: number };

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

export type ArtifactsWatchRequest = {
	userId: string;
	repositoryKey: string;
	workspacePath: string;
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

export type ToolInstall =
	{ state: 'installing' } | { state: 'installed' } | { state: 'failed'; error: string };

export type SignInStatus =
	| { state: 'idle' }
	| { state: 'starting' }
	| { state: 'waiting'; url: string; code: string | null }
	| { state: 'failed'; error: string };

export type SignInTarget = { connector: 'github'; host: string } | { connector: 'vercel' };

export type CliConnector = SignInTarget['connector'];

export type GitHubHostStatus = {
	host: string;
	enabled: boolean;
	source: 'environment' | 'gitHubCli' | null;
	login: string | null;
	problem: string | null;
};

export type GitHubStatus = {
	install: ToolInstall;
	enabled: boolean;
	cliVersion: string | null;
	hosts: GitHubHostStatus[];
};

export type RepositoryVisibility = 'public' | 'private';

export type VercelStatus = {
	install: ToolInstall;
	version: string;
	account:
		| { state: 'signedOut' }
		| { state: 'signedIn'; login: string; source: 'cli' | 'environment' }
		| { state: 'problem'; error: string };
};

export type GitHubSettingsUpdate = {
	enabled?: boolean;
	host?: { host: string; enabled: boolean };
};

export type ConnectorStatus = {
	id: 'kicad';
	name: string;
	state: 'notInstalled' | 'installing' | 'failed' | 'installed';
	error: string | null;
	updateAvailable: boolean;
	kicadVersion: string | null;
};

export type ChatGptBrowserLoginResult = {
	status: 'pending' | 'complete' | 'error';
	error?: string;
};

export type ClaudeCodeStatus = {
	state: 'notInstalled' | 'installing' | 'outdated' | 'installed';
	version: string | null;
	minimumVersion: string;
	installCommand: string;
	error: string | null;
};

export type ClaudeCodeLoginStart = {
	loginId: string;
	url: string;
};

export type MuseStatus = {
	state: 'notInstalled' | 'installing' | 'outdated' | 'signedOut' | 'planRequired' | 'ready';
	version: string | null;
	minimumVersion: string;
	installCommand: string;
	account: string | null;
	error: string | null;
};

export type MuseLoginStart = {
	loginId: string;
	verificationUrl: string;
	userCode: string;
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

export type WorkspaceFilesResult = {
	directories: string[];
	files: string[];
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

export type DiskEvent<T> = ({ kind: 'snapshot' } & T) | { kind: 'error'; message: string };

export type WatchHandlers<T> = { onEvent: (event: T) => void; signal: AbortSignal };

export type SubscriptionHandlers<T> = WatchHandlers<T> & { onError: (error: Error) => void };

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
	ensureBrowser: (signal?: AbortSignal) => Promise<BrowserStatus>;
	browserDashboardUrl: string;
	watchBrowserStatus: (handlers: WatchHandlers<BrowserStatus>) => Promise<void>;
	watchRunningCommands: (
		request: TranscriptScopeRequest,
		handlers: SubscriptionHandlers<RunningCommand[]>
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
	readWorkspaceText: (
		input: WorkspaceFileTarget,
		signal?: AbortSignal
	) => Promise<{ content: string; version: string }>;
	kicadScene: (
		input: WorkspaceFileTarget,
		signal?: AbortSignal
	) => Promise<{ scene: ReadableStream<Uint8Array<ArrayBuffer>>; version: string }>;
	/** KiCad's GLB of the board's component models, or `null` when no footprint has a model. */
	kicadModels: (
		input: WorkspaceFileTarget,
		signal?: AbortSignal
	) => Promise<ReadableStream<Uint8Array<ArrayBuffer>> | null>;
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
	fetchTranscriptRows: (
		request: TranscriptRowsRequest,
		signal?: AbortSignal
	) => Promise<TranscriptSnapshot>;
	fetchTranscriptRow: (
		request: TranscriptRowRequest,
		signal?: AbortSignal
	) => Promise<{ row: TranscriptRow }>;
	watchTranscript: (
		request: TranscriptScopeRequest & { before?: number },
		handlers: WatchHandlers<TranscriptEvent>
	) => Promise<void>;
	watchTranscriptWork: (
		request: TranscriptWorkRequest,
		handlers: WatchHandlers<TranscriptEvent>
	) => Promise<void>;
	watchTranscriptItem: (
		request: TranscriptRowRequest,
		handlers: WatchHandlers<TranscriptEvent>
	) => Promise<void>;
	fetchTranscriptAttachment: (
		request: TranscriptScopeRequest & { storageId: Id<'_storage'> }
	) => Promise<Blob | null>;
	uploadTranscriptAttachment: (request: TranscriptUploadRequest) => Promise<TranscriptUploadResult>;
	discardTranscriptAttachment: (request: TranscriptDiscardRequest) => Promise<boolean>;
	deleteArtifact: (request: ArtifactsWatchRequest & { artifactId: string }) => Promise<void>;
	watchArtifactSync: (
		request: ArtifactsWatchRequest,
		handlers: SubscriptionHandlers<null>
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
	finishChatGptBrowserLogin: (request: LocalUserRequest & { callbackUrl: string }) => Promise<void>;
	cancelChatGptBrowserLogin: (request: LocalUserRequest & { state: string }) => Promise<void>;
	selectChatGptAccount: (request: LocalUserRequest & { connectionId: string }) => Promise<void>;
	disconnectChatGptAccount: (
		request: LocalUserRequest & { connectionId: string }
	) => Promise<string | null>;
	fetchGitHubStatus: (userId: string) => Promise<GitHubStatus>;
	updateGitHubSettings: (userId: string, update: GitHubSettingsUpdate) => Promise<GitHubStatus>;
	cloneRepository: (input: {
		userId: string;
		source: string;
		parentPath: string;
	}) => Promise<WorkspacePathResolution>;
	createGitHubRepository: (input: {
		userId: string;
		name: string;
		visibility: RepositoryVisibility;
		parentPath: string;
	}) => Promise<WorkspacePathResolution>;
	signOutGitHub: (userId: string, host: string) => Promise<GitHubStatus>;
	fetchVercelStatus: (userId: string) => Promise<VercelStatus>;
	signOutVercel: (userId: string) => Promise<VercelStatus>;
	installConnectorCli: (userId: string, connector: CliConnector) => Promise<ToolInstall>;
	fetchConnectorSignIn: (userId: string, target: SignInTarget) => Promise<SignInStatus>;
	startConnectorSignIn: (userId: string, target: SignInTarget) => Promise<SignInStatus>;
	cancelConnectorSignIn: (userId: string, target: SignInTarget) => Promise<SignInStatus>;
	fetchConnectors: (userId: string) => Promise<ConnectorStatus[]>;
	installOrUpdateConnector: (userId: string, id: ConnectorStatus['id']) => Promise<ConnectorStatus>;
	uninstallConnector: (userId: string, id: ConnectorStatus['id']) => Promise<ConnectorStatus>;
	fetchClaudeCodeStatus: (userId: string) => Promise<ClaudeCodeStatus>;
	installClaudeCode: (userId: string) => Promise<ClaudeCodeStatus>;
	startClaudeCodeLogin: (userId: string) => Promise<ClaudeCodeLoginStart>;
	finishClaudeCodeLogin: (userId: string, loginId: string, code: string) => Promise<string>;
	cancelClaudeCodeLogin: (userId: string, loginId: string) => Promise<void>;
	fetchMuseStatus: (userId: string) => Promise<MuseStatus>;
	installMuse: (userId: string) => Promise<MuseStatus>;
	startMuseLogin: (userId: string) => Promise<MuseLoginStart>;
	cancelMuseLogin: (userId: string, loginId: string) => Promise<void>;
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
