import {
	useCallback,
	type ComponentProps,
	useEffect,
	useEffectEvent,
	useLayoutEffect,
	useMemo,
	useRef,
	useState
} from 'react';
import { PanelRight, Settings } from 'lucide-react';
import {
	useAction,
	useConvex,
	useConvexAuth,
	useMutation,
	useQuery_experimental as useConvexQueryResult
} from 'convex/react';
import type { FunctionArgs, FunctionReference } from 'convex/server';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { api } from '@convex/_generated/api';
import {
	advanceConvexAuthRetryPending,
	authState,
	cancelDesktopSignIn,
	clearDesktopSignInOpenError,
	convexAuthRetryPending,
	convexAuthUserId,
	reconcileNativeAuthentication,
	retryConvexAuthentication,
	signIn,
	signOut as authSignOut,
	signUp
} from '$lib/auth';
import { useStore } from '$lib/store';
import type { RuntimeConfig } from '$lib/runtime-config';
import AuthGate from '$lib/components/home/auth-gate';
import BrowserSignInOverlay from '$lib/components/home/browser-signin-overlay';
import CalmCentered from '$lib/components/home/calm-centered';
import PromptComposer from '$lib/components/home/prompt-composer';
import ConversationNotices from '$lib/components/home/conversation-notices';
import CreateThreadHeading from '$lib/components/home/create-thread-heading';
import '$lib/components/home/create-thread.css';
import '$lib/components/home/inbox.css';
import BrandMark from '$lib/components/brand-mark';
import InboxSidebar, { type SidebarChildrenResolver } from '$lib/components/home/inbox-sidebar';
import InboxLoadMore from '$lib/components/home/inbox-load-more';
import SettingsAccount from '$lib/components/home/settings-account';
import SettingsAiUsage from '$lib/components/home/settings-ai-usage';
import RunUsageFooter from '$lib/components/home/run-usage-footer';
import SettingsGeneral from '$lib/components/home/settings-general';
import SettingsPayments from '$lib/components/home/settings-payments';
import SettingsCredentials from '$lib/components/home/settings-credentials';
import SettingsProviders from '$lib/components/home/settings-providers';
import SettingsVersionControl from '$lib/components/home/settings-version-control';
import SettingsSidebar, { type SettingsPage } from '$lib/components/home/settings-sidebar';
import ThreadTranscript from '$lib/components/home/thread-transcript';
import SidePanel from '$lib/components/home/side-panel';
import SidePanelResizeHandle from '$lib/components/home/side-panel-resize-handle';
import { minLayoutSize } from '$lib/chat/side-panel';
import { useSidePanelWidth } from '$lib/home/side-panel-width';
import { useExistingThreadCwd } from '$lib/home/thread-cwd';
import ArtifactScreenFullscreen from '$lib/components/home/artifact-screen-fullscreen';
import { createConvexArtifactClient, useArtifactPanel } from '$lib/home/artifact-panel';
import ProjectPicker, { type ProjectSelection } from '$lib/components/home/project-picker';
import RemoveProjectDialog from '$lib/components/home/remove-project-dialog';
import {
	attachLocalProject as attachLocalProjectForPath,
	compareProjectRecency,
	findCanonicalProjectAttachment,
	launchAgentRun,
	lifecycleResumeKind,
	refreshDesktopProjectAttachments as refreshDesktopProjectAttachmentsFromDesktop,
	projectFromAttachment,
	resolveSubmissionId,
	upsertDesktopProjectAttachment,
	verifyProjectAttachment as verifyProjectAttachmentForExecution,
	type ProjectState
} from '$lib/home/desktop';
import { convexClientErrorMessage } from '$lib/convex-error';
import type { ComposerAttachment } from '$lib/chat/attachments';
import {
	MarkdownFileLinksContext,
	openMarkdownLink,
	type MarkdownFileLinks
} from '$lib/chat/markdown-file-links';
import { useComposerAttachments } from '$lib/home/composer-attachments';
import type { CompletionProvider } from '@convex/lib/validators';
import {
	CATALOG_UNAVAILABLE_MESSAGE,
	fetchGatewayModelCatalog,
	getCatalogModel,
	type CatalogModelId,
	type ModelCatalog
} from '$lib/chat/model-catalog';
import { providersForModel, usableProviders } from '$lib/chat/providers';
import { enabledProviders } from '@convex/lib/providerOrder';
import { isLifecycleInProgress } from '@convex/lib/runCancellation';
import {
	beginPendingAgentLaunch,
	clearPendingAgentLaunch,
	dataForThread,
	findThreadById,
	findProjectByRepositoryKey,
	findProjectByWorkspacePath,
	isActiveThread,
	isAgentLaunchPending,
	isLatestRunReadyForThread,
	resolveInitialDraftSelection,
	resolvePendingAgentLaunch,
	resolvePendingCreatedThreadId,
	resolveProjectThreadSelection,
	threadRecordToSummary,
	type PendingAgentLaunch,
	type PendingAgentLaunches
} from '$lib/project/threads';
import { useRevealInboxThread, useThreadInbox } from '$lib/project/inbox';
import {
	usePullRequestRefresher,
	useShownPullRequests,
	type PullRequestRefresher,
	type PullRequestStateSync
} from '$lib/project/pullRequestRefresh';
import {
	useExpandedThreads,
	useRevealPaginatedThread,
	useSelectedThreadAncestryReveal,
	useThreadChildren,
	type UseExpandedThreads
} from '$lib/project/useThreadTree';
import type { InboxState } from '@convex/lib/inboxState';
import { useTranscriptReplica } from '$lib/home/transcript-replica';
import type { TranscriptDisplayRow, TranscriptDetailCursor } from '$lib/types/sprocket';
import { clearLaunchHash, readWorkspaceLaunchFromHash, resolveLocalApi } from '$lib/local/client';
import { LocalResponseError } from '$lib/local/transport';
import { applyTheme, resolveTheme, type SprocketTheme } from '$lib/theme';
import type {
	ChatGptStatus,
	LocalApi,
	ExecutorJob,
	ThreadSummary,
	ProjectAttachment
} from '$lib/types/sprocket';
import { cn } from '$lib/utils';
import { syncShareConversationContent } from '$lib/analytics';

type ConvexQuery = FunctionReference<'query'>;

// Query failures belong in the page's inline error UI, not the startup boundary.
function usePageQuery<Query extends ConvexQuery>(query: Query, args: FunctionArgs<Query> | 'skip') {
	const result = useConvexQueryResult({ query, args });

	if (result.status === 'error') return { data: undefined, error: result.error };

	if (result.status === 'pending') return { data: undefined, error: null };

	return { data: result.data, error: null };
}

const localServerRequiredMessage = 'Connect to a running Sprocket server to use this project.';

const noProviderMessage =
	'No enabled provider offers this model. Check your providers in Settings → Providers.';

const agentLaunchTimeoutMs = 30_000;

type SidebarProps = ComponentProps<typeof InboxSidebar>;

function InboxSidebarContainer(
	props: Omit<SidebarProps, 'expansion' | 'resolveChildren'> & {
		signedInUserId: string | null;
		repositoryKeys: string[];
		pullRequestRefresher: PullRequestRefresher | null;
	}
) {
	const { pullRequestRefresher, ...sidebarProps } = props;
	const expansion = useExpandedThreads(props.signedInUserId);

	useShownPullRequests(
		pullRequestRefresher,
		props.sections.flatMap((section) =>
			section.state === 'settled' && !props.settledOpen ? [] : section.rows
		)
	);

	const selectedPath = useSelectedThreadAncestryReveal({
		currentThreadId: props.currentThreadId,
		enabled: props.mutationsEnabled,
		expansion
	});

	const rootId = selectedPath[0] ?? null;

	const rootQuery = useConvexQueryResult({
		query: api.threads.getByThreadId,
		args: props.mutationsEnabled && rootId ? { threadId: rootId } : 'skip'
	});

	useRevealInboxThread(
		rootQuery.status === 'success' ? rootQuery.data : null,
		props.repositoryKeys,
		props.sections
	);

	const resolveChildren: SidebarChildrenResolver = useCallback(
		({ threadId, renderRows }) => (
			<ExpandedThreadChildren
				expansion={expansion}
				threadId={threadId}
				renderRows={renderRows}
				selectedPath={selectedPath}
				pullRequestRefresher={pullRequestRefresher}
			/>
		),
		[expansion, selectedPath, pullRequestRefresher]
	);

	return <InboxSidebar {...sidebarProps} expansion={expansion} resolveChildren={resolveChildren} />;
}

function ExpandedThreadChildren({
	expansion,
	threadId,
	renderRows,
	selectedPath,
	pullRequestRefresher
}: Parameters<SidebarChildrenResolver>[0] & {
	expansion: UseExpandedThreads;
	selectedPath: readonly Id<'threadRecords'>[];
	pullRequestRefresher: PullRequestRefresher | null;
}) {
	const children = useThreadChildren(threadId);

	useShownPullRequests(pullRequestRefresher, children.rows);

	const parentIndex = selectedPath.indexOf(threadId);
	useRevealPaginatedThread(
		parentIndex >= 0 ? (selectedPath[parentIndex + 1] ?? null) : null,
		children
	);

	useEffect(() => {
		expansion.registerChildren(threadId, children.rows);
	}, [expansion, threadId, children.rows]);

	return (
		<>
			{renderRows(children.rows)}
			<InboxLoadMore section={children} />
		</>
	);
}

export type AppRuntime = {
	resolveLocalApi: () => Promise<LocalApi>;
	fetchGatewayModelCatalog: (origin: string) => Promise<ModelCatalog>;
};

const productionAppRuntime: AppRuntime = { resolveLocalApi, fetchGatewayModelCatalog };

function getComposerScope(threadId: Id<'threadRecords'> | null, workspacePath: string | null) {
	return threadId ? `thread:${threadId}` : workspacePath ? `draft:${workspacePath}` : null;
}

function getComposerRecoveryKey(userId: string, scope: string) {
	return `${userId}\0${scope}`;
}

type ComposerRecovery = {
	message: string | null;
	prompt: string;
	attachments?: ComposerAttachment[];
	storageIds?: Id<'_storage'>[];
	reasoningEffort?: string;
	fastMode?: boolean;
	selectedModel?: CatalogModelId;
	completionProvider?: CompletionProvider;
	submissionId?: string;
	continuationOfRunId?: Id<'runs'>;
	autoSubmit?: boolean;
};

export default function App({
	config,
	runtime = productionAppRuntime
}: {
	config: RuntimeConfig;
	runtime?: AppRuntime;
}) {
	const configRef = useRef(config);
	const runtimeRef = useRef(runtime);
	runtimeRef.current = runtime;

	const convexAuth = useConvexAuth();
	const convexClient = useConvex();
	const auth = useStore(authState);
	const retryPending = useStore(convexAuthRetryPending);
	const signedInUserId = useStore(convexAuthUserId);
	const isSignedIn = Boolean(signedInUserId);
	// Async work (agent launches, uploads, mutations) must compare against the
	// account that is signed in when it resumes, not the one captured by the
	// render that started it.
	const signedInUserIdRef = useRef(signedInUserId);
	const nativeAuthLoading = auth.nativeSession === 'loading';

	const nativeAuthBlocked =
		auth.nativeSession === 'missing' ||
		auth.nativeSession === 'mismatch' ||
		auth.nativeSession === 'unavailable';

	const nativeSignInRequired =
		auth.nativeSession === 'missing' || auth.nativeSession === 'mismatch';

	const authReady =
		auth.isReady &&
		!auth.isLoading &&
		isSignedIn &&
		(auth.nativeSession === 'notRequired' || auth.nativeSession === 'ready') &&
		!convexAuth.isLoading &&
		convexAuth.isAuthenticated;

	const authConnectionFailed =
		isSignedIn &&
		auth.isReady &&
		!auth.isLoading &&
		!retryPending &&
		!convexAuth.isLoading &&
		!convexAuth.isAuthenticated;

	const authGateBlocked = authConnectionFailed || nativeAuthBlocked;

	const [sawAuthLoadingDuringRetry, setSawAuthLoadingDuringRetry] = useState(false);
	useEffect(() => {
		const next = advanceConvexAuthRetryPending({
			retryPending,
			isAuthenticated: convexAuth.isAuthenticated,
			isLoading: convexAuth.isLoading,
			sawLoadingDuringRetry: sawAuthLoadingDuringRetry
		});

		if (sawAuthLoadingDuringRetry !== next.sawLoadingDuringRetry) {
			setSawAuthLoadingDuringRetry(next.sawLoadingDuringRetry);
		}

		if (next.clearPending) {
			convexAuthRetryPending.set(false);
		}
	}, [retryPending, convexAuth.isAuthenticated, convexAuth.isLoading, sawAuthLoadingDuringRetry]);

	const getMyProviderConfiguration = useAction(api.providerCredentials.getMyConfiguration);
	const deleteArtifactRecord = useMutation(api.artifacts.deleteArtifact);
	const renameThreadRecord = useMutation(api.threads.rename);
	const regenerateThreadTitleRecord = useAction(api.threadTitles.regenerate);
	const settleThreadRecord = useMutation(api.threads.settle);
	const unsettleThreadRecord = useMutation(api.threads.unsettle);
	const answerAgentQuestion = useMutation(api.agentQuestions.answer);
	const setThemePreference = useMutation(api.uiPreferences.setTheme);
	const ensureMySubscription = useMutation(api.billing.ensureMySubscription);
	const updatePullRequestStates = useMutation(api.pullRequests.updateStates);

	const [modelCatalog, setModelCatalog] = useState<ModelCatalog | undefined>(undefined);
	const [catalogError, setCatalogError] = useState<string | null>(null);
	const [catalogLoading, setCatalogLoading] = useState(true);
	const [openAiConfigured, setOpenAiConfigured] = useState(false);
	const [chatGptConfigured, setChatGptConfigured] = useState(false);
	const [chatGptStatus, setChatGptStatus] = useState<ChatGptStatus | null>(null);
	const [chatGptStatusLoading, setChatGptStatusLoading] = useState(false);
	const [chatGptStatusError, setChatGptStatusError] = useState<string | null>(null);
	const [providerConfigurationLoading, setProviderConfigurationLoading] = useState(false);
	const [providerConfigurationReady, setProviderConfigurationReady] = useState(false);
	const [providerConfigurationError, setProviderConfigurationError] = useState<string | null>(null);

	const configuredProviders = useMemo<CompletionProvider[]>(
		() => [
			'spikonado',
			...(openAiConfigured ? (['openai'] as const) : []),
			...(chatGptConfigured ? (['chatgpt'] as const) : [])
		],
		[openAiConfigured, chatGptConfigured]
	);

	async function loadModelCatalog() {
		setCatalogLoading(true);

		try {
			const origin = configRef.current.env.PUBLIC_MODEL_GATEWAY_URL?.trim() ?? '';
			setModelCatalog(await runtimeRef.current.fetchGatewayModelCatalog(origin));
			setCatalogError(null);
		} catch {
			setCatalogError(CATALOG_UNAVAILABLE_MESSAGE);
			setModelCatalog(undefined);
		} finally {
			setCatalogLoading(false);
		}
	}

	const ensureSubscriptionAttemptedFor = useRef<string | null>(null);
	const providerConfigurationLoadedFor = useRef<string | null>(null);
	const providerConfigurationGeneration = useRef(0);

	async function loadProviderConfiguration(userId: string) {
		const generation = providerConfigurationGeneration.current;
		setProviderConfigurationLoading(true);
		setProviderConfigurationReady(false);
		setProviderConfigurationError(null);

		try {
			const configuration = await getMyProviderConfiguration({});

			if (
				signedInUserIdRef.current !== userId ||
				generation !== providerConfigurationGeneration.current
			)
				return;
			setOpenAiConfigured(configuration.openai);
			setProviderConfigurationReady(true);
		} catch (error) {
			if (
				signedInUserIdRef.current !== userId ||
				generation !== providerConfigurationGeneration.current
			)
				return;
			setProviderConfigurationError(
				(error instanceof Error && convexClientErrorMessage(error)) ||
					'Couldn’t load provider settings.'
			);
		} finally {
			if (
				signedInUserIdRef.current === userId &&
				generation === providerConfigurationGeneration.current
			) {
				setProviderConfigurationLoading(false);
			}
		}
	}

	const loadProviderConfigurationEvent = useEffectEvent((userId: string) => {
		loadProviderConfiguration(userId);
	});

	useEffect(() => {
		if (!authReady) return;
		const userId = signedInUserIdRef.current;

		if (!userId || ensureSubscriptionAttemptedFor.current === userId) return;
		// Attempt once per signed-in user. Best-effort bootstrap; the backend
		// also ensures a row on first metered usage, so a failure is safe to
		// swallow and must not re-trigger the effect into a tight retry loop.
		ensureSubscriptionAttemptedFor.current = userId;
		void ensureMySubscription({}).catch(() => {});
	}, [authReady, signedInUserId, ensureMySubscription]);

	useEffect(() => {
		if (!authReady) return;
		const userId = signedInUserIdRef.current;

		if (!userId || providerConfigurationLoadedFor.current === userId) return;
		providerConfigurationLoadedFor.current = userId;
		loadProviderConfigurationEvent(userId);
	}, [authReady, signedInUserId]);

	const [localApi, setLocalApi] = useState<LocalApi | null>(null);
	const localApiRef = useRef(localApi);
	const [localApiResolved, setLocalApiResolved] = useState(false);

	const chatGptStatusLoadedFor = useRef<{ userId: string; api: LocalApi } | null>(null);
	const chatGptStatusGeneration = useRef(0);

	const chatGptStatusChangeEvent = useEffectEvent((status: ChatGptStatus) => {
		handleChatGptStatusChange(status);
	});

	useEffect(() => {
		const userId = signedInUserId;

		if (!authReady || !userId || !localApi) {
			chatGptStatusLoadedFor.current = null;
			setChatGptStatus(null);
			setChatGptConfigured(false);
			setChatGptStatusLoading(false);

			return;
		}

		if (
			chatGptStatusLoadedFor.current?.userId === userId &&
			chatGptStatusLoadedFor.current.api === localApi
		)
			return;
		chatGptStatusLoadedFor.current = { userId, api: localApi };
		const generation = ++chatGptStatusGeneration.current;
		setChatGptStatus(null);
		setChatGptConfigured(false);
		setChatGptStatusLoading(true);
		setChatGptStatusError(null);
		localApi
			.fetchChatGptStatus({ userId })
			.then((status) => {
				if (
					generation !== chatGptStatusGeneration.current ||
					signedInUserIdRef.current !== userId
				) {
					return;
				}

				chatGptStatusChangeEvent(status);
			})
			.catch((error: Error) => {
				if (
					generation !== chatGptStatusGeneration.current ||
					signedInUserIdRef.current !== userId
				) {
					return;
				}

				setChatGptStatus(null);
				setChatGptConfigured(false);
				setChatGptStatusError(
					(error instanceof Error && convexClientErrorMessage(error)) ||
						'Couldn’t load ChatGPT connection status.'
				);
			})
			.finally(() => {
				if (
					generation === chatGptStatusGeneration.current &&
					signedInUserIdRef.current === userId
				) {
					setChatGptStatusLoading(false);
				}
			});

		return () => {
			chatGptStatusGeneration.current += 1;
			chatGptStatusLoadedFor.current = null;
		};
	}, [authReady, signedInUserId, localApi]);

	const [currentWorkspacePath, setCurrentWorkspacePath] = useState<string | null>(null);
	const [currentRepositoryKey, setCurrentRepositoryKey] = useState<string | null>(null);
	const [currentThreadId, setCurrentThreadId] = useState<Id<'threadRecords'> | null>(null);
	const [draftWorkspacePath, setDraftWorkspacePath] = useState<string | null>(null);
	const [selectedModel, setSelectedModel] = useState<CatalogModelId>();

	const [selectedReasoningEffort, setSelectedReasoningEffort] = useState<string>();

	const [fastMode, setFastMode] = useState(false);
	const [prompt, setPrompt] = useState('');
	const [selectedQuestionOptionId, setSelectedQuestionOptionId] = useState<string | null>(null);
	const [answeringAgentQuestion, setAnsweringAgentQuestion] = useState(false);

	const [composerContinuationOfRunId, setComposerContinuationOfRunId] = useState<Id<'runs'> | null>(
		null
	);

	const [autoSubmitComposerContinuation, setAutoSubmitComposerContinuation] = useState(false);
	const [currentError, setCurrentError] = useState<string | null>(null);

	const [pendingAgentLaunches, setPendingAgentLaunches] = useState<PendingAgentLaunches>({});
	const [hasResolvedInitialSelection, setHasResolvedInitialSelection] = useState(false);
	const projectSelectionGeneration = useRef(0);

	const [pendingCreatedThreadId, setPendingCreatedThreadId] = useState<Id<'threadRecords'> | null>(
		null
	);

	const [desktopProjectAttachmentsByPath, setDesktopProjectAttachmentsByPath] = useState<
		Record<string, ProjectAttachment>
	>({});

	const desktopProjectAttachmentsRef = useRef(desktopProjectAttachmentsByPath);

	const [hasLoadedDesktopProjectAttachments, setHasLoadedDesktopProjectAttachments] =
		useState(false);

	const [selectionUserId, setSelectionUserId] = useState<string | null>(null);
	const [projectPickerOpen, setProjectPickerOpen] = useState(false);

	const [projectToRemove, setProjectToRemove] = useState<{
		workspacePath: string;
		displayName: string;
	} | null>(null);

	const [projectPickerMode, setProjectPickerMode] = useState<'add' | 'reconnect'>('add');

	const [projectPickerExpectedDisplayName, setProjectPickerExpectedDisplayName] = useState<
		string | undefined
	>(undefined);

	const [projectPickerReconnectWorkspacePath, setProjectPickerReconnectWorkspacePath] = useState<
		string | null
	>(null);

	const [settingsOpen, setSettingsOpen] = useState(false);
	const [settingsPage, setSettingsPage] = useState<SettingsPage>('general');
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const [viewportWidth, setViewportWidth] = useState(0);
	const sidebarVisible = sidebarOpen || (settingsOpen && viewportWidth >= 768);
	const sidePanelWidth = useSidePanelWidth(viewportWidth, sidebarVisible);
	const [projectFilter, setProjectFilter] = useState<string[]>([]);
	const [settledInboxOpen, setSettledInboxOpen] = useState(false);
	const [pendingProjectLaunches, setPendingProjectLaunches] = useState<string[]>([]);
	const [initialProjectLaunchResolved, setInitialProjectLaunchResolved] = useState(false);

	const [createThreadComposerElement, setCreateThreadComposerElement] =
		useState<HTMLElement | null>(null);

	// Submission and recovery bookkeeping. These are concurrency guards and
	// caches; rendering never reads them directly. Rendering reads go through
	// submissionTrackingVersion, bumped by every mutation.
	const submittingPromptScopes = useRef(new Map<string, number>()).current;
	const composerRecoveries = useRef(new Map<string, ComposerRecovery>()).current;

	const recoveredSubmissionIds = useRef(
		new Map<
			string,
			{
				prompt: string;
				storageIds: Id<'_storage'>[];
				reasoningEffort: string;
				fastMode: boolean;
				selectedModel: CatalogModelId;
				completionProvider: CompletionProvider;
				submissionId: string;
				continuationOfRunId?: Id<'runs'>;
			}
		>()
	).current;

	const latestSubmissionSequencesByRecoveryScope = useRef(new Map<string, number>()).current;
	const nextAgentLaunchId = useRef(0);
	const nextSubmissionSequence = useRef(0);
	const lastSyncedComposerThreadId = useRef<Id<'threadRecords'> | null>(null);
	const desktopProjectAttachmentsGeneration = useRef(0);
	const [projectLaunchInFlight, setProjectLaunchInFlight] = useState(false);
	const lastAppliedThemePreferences = useRef<Doc<'uiPreferences'> | null | undefined>(undefined);
	const [pendingTheme, setPendingTheme] = useState<SprocketTheme | null>(null);
	const themeSaveGeneration = useRef(0);

	const [submissionTrackingVersion, setSubmissionTrackingVersion] = useState(0);

	const bumpSubmissionTracking = useCallback(
		() => setSubmissionTrackingVersion((version) => version + 1),
		[]
	);

	const clearSubmittingPrompt = useCallback(
		(scope: string, submissionSequence: number) => {
			if (submittingPromptScopes.get(scope) === submissionSequence) {
				submittingPromptScopes.delete(scope);
				bumpSubmissionTracking();
			}
		},
		[bumpSubmissionTracking, submittingPromptScopes]
	);

	const storeComposerRecovery = useCallback(
		(userId: string, scope: string, recovery: ComposerRecovery) => {
			composerRecoveries.set(getComposerRecoveryKey(userId, scope), recovery);
			bumpSubmissionTracking();
		},
		[bumpSubmissionTracking, composerRecoveries]
	);

	const clearComposerRecovery = useCallback(
		(userId: string, scope: string) => {
			const recoveryKey = getComposerRecoveryKey(userId, scope);
			composerRecoveries.delete(recoveryKey);
			recoveredSubmissionIds.delete(recoveryKey);
			bumpSubmissionTracking();
		},
		[bumpSubmissionTracking, composerRecoveries, recoveredSubmissionIds]
	);

	const composerAttachments = useComposerAttachments({
		context: {
			api: localApi,
			userId: signedInUserId,
			threadId: currentThreadId
		},
		onError: setCurrentError,
		localServerRequiredMessage
	});

	const transcript = useTranscriptReplica();
	const artifactPanel = useArtifactPanel();
	// Phones have no room beside the thread, so the side panel always covers it.
	const phoneViewport = viewportWidth > 0 && viewportWidth < 768;
	const sidePanelFullscreen = artifactPanel.panel.expanded || phoneViewport;
	const artifactClient = useMemo(() => createConvexArtifactClient(convexClient), [convexClient]);

	// Queries stay skipped until Convex confirms the token; running them on the
	// account id alone surfaces a spurious auth error during sign-in.
	const authenticatedQueryArgs =
		signedInUserId && convexAuth.isAuthenticated && !convexAuth.isLoading ? {} : 'skip';

	const uiPreferencesQuery = usePageQuery(api.uiPreferences.getMine, authenticatedQueryArgs);
	const providerOrder = uiPreferencesQuery.data?.providerOrder;

	const availableProviders = useMemo(
		() => usableProviders(providerOrder, configuredProviders),
		[providerOrder, configuredProviders]
	);

	const providerStatusKnown: Record<CompletionProvider, boolean> = {
		spikonado: true,
		openai: providerConfigurationReady || providerConfigurationError !== null,
		chatgpt:
			localApiResolved && (!localApi || chatGptStatus !== null || chatGptStatusError !== null)
	};

	const selectedCatalogModel =
		modelCatalog && selectedModel ? getCatalogModel(modelCatalog, selectedModel) : undefined;

	const enabledProviderOrder = enabledProviders(providerOrder);

	const routeProviders = selectedCatalogModel
		? providersForModel(enabledProviderOrder, selectedCatalogModel)
		: enabledProviderOrder;

	const spikonadoIndex = routeProviders.indexOf('spikonado');

	// Spikonado is always usable, so providers after it cannot change which one runs first.
	// A failed preferences read must not fall back to the default order and re-enable providers.
	const providersReady =
		uiPreferencesQuery.data !== undefined &&
		(spikonadoIndex === -1 ? routeProviders : routeProviders.slice(0, spikonadoIndex)).every(
			(provider) => providerStatusKnown[provider]
		);

	const currentProvider = providersForModel(availableProviders, selectedCatalogModel).at(0);

	const authenticatedThreadQueryArgs =
		currentThreadId && authenticatedQueryArgs !== 'skip' ? { threadId: currentThreadId } : 'skip';

	const activeThreadQuery = usePageQuery(api.threads.getByThreadId, authenticatedThreadQueryArgs);

	const lifecycleQuery = usePageQuery(
		api.chat.selectedThreadLifecycle,
		authenticatedThreadQueryArgs
	);

	const pendingAgentQuestionQuery = usePageQuery(
		api.agentQuestions.headPendingForThread,
		authenticatedThreadQueryArgs
	);

	const queryError =
		uiPreferencesQuery.error ??
		activeThreadQuery.error ??
		lifecycleQuery.error ??
		pendingAgentQuestionQuery.error;

	const [workspaceTheme, setWorkspaceTheme] = useState<SprocketTheme>(resolveTheme(null));
	useEffect(() => {
		if (!authReady) {
			lastAppliedThemePreferences.current = undefined;
			setPendingTheme(null);
			themeSaveGeneration.current += 1;

			return;
		}

		const preferences = uiPreferencesQuery.data;

		// Wait for Convex before applying a workspace theme (boot script stays light for entry).
		if (preferences === undefined) return;

		// Ignore preference snapshots while a theme save is in flight.
		if (pendingTheme !== null) return;

		if (preferences === lastAppliedThemePreferences.current) return;
		lastAppliedThemePreferences.current = preferences;
		const nextTheme = resolveTheme(preferences?.theme);
		setWorkspaceTheme(nextTheme);
		applyTheme(nextTheme);
	}, [authReady, uiPreferencesQuery.data, pendingTheme]);

	const shareConversationContent =
		uiPreferencesQuery.data === undefined
			? undefined
			: (uiPreferencesQuery.data?.shareConversationContent ?? true);

	useEffect(() => {
		if (shareConversationContent !== undefined) {
			syncShareConversationContent(shareConversationContent);
		}
	}, [shareConversationContent]);

	async function handleThemeChange(theme: SprocketTheme) {
		const previous = workspaceTheme;
		const generation = ++themeSaveGeneration.current;
		setPendingTheme(theme);
		setWorkspaceTheme(theme);
		applyTheme(theme);

		try {
			await setThemePreference({ theme });
		} catch (error) {
			if (generation !== themeSaveGeneration.current) return;
			setWorkspaceTheme(previous);
			applyTheme(previous);
			setCurrentError(error instanceof Error ? error.message : 'Failed to save theme preference.');
		} finally {
			if (generation === themeSaveGeneration.current) setPendingTheme(null);
		}
	}

	const orderedProjectAttachments = useMemo(
		() => Object.values(desktopProjectAttachmentsByPath).sort(compareProjectRecency),
		[desktopProjectAttachmentsByPath]
	);

	const projects = useMemo<ProjectState[]>(
		() => orderedProjectAttachments.map(projectFromAttachment),
		[orderedProjectAttachments]
	);

	const inboxProjects = useMemo(
		() => [...new Map(projects.map((project) => [project.repositoryKey, project])).values()],
		[projects]
	);

	const inboxProjectKeys = useMemo(() => {
		const attachedKeys = inboxProjects.map((project) => project.repositoryKey);
		const filteredKeys = projectFilter.filter((key) => attachedKeys.includes(key));

		return filteredKeys.length > 0 ? filteredKeys : attachedKeys;
	}, [projectFilter, inboxProjects]);

	useEffect(() => {
		const attachedKeys = new Set(inboxProjects.map((project) => project.repositoryKey));
		const attachedFilter = projectFilter.filter((key) => attachedKeys.has(key));

		if (attachedFilter.length !== projectFilter.length) setProjectFilter(attachedFilter);
	}, [inboxProjects, projectFilter]);

	const inbox = useThreadInbox({
		enabled: authReady,
		repositoryKeys: inboxProjectKeys,
		settledOpen: settledInboxOpen
	});

	const currentActiveThread = dataForThread(activeThreadQuery.data, currentThreadId);

	const threads = useMemo<ThreadSummary[]>(() => {
		const summaries =
			inbox.sections
				.find((section) => section.state === 'unsettled')
				?.rows.map(threadRecordToSummary) ?? [];

		if (
			!currentActiveThread ||
			summaries.some((thread) => thread.threadId === currentActiveThread._id)
		) {
			return summaries;
		}

		return [threadRecordToSummary(currentActiveThread), ...summaries];
	}, [inbox.sections, currentActiveThread]);

	const currentLifecycle = dataForThread(lifecycleQuery.data, currentThreadId);

	const pullRequestStateSync = useMemo<PullRequestStateSync | null>(
		() =>
			localApi && authReady && signedInUserId
				? {
						fetchStates: (pullRequests) =>
							localApi.fetchPullRequestStates({ userId: signedInUserId, pullRequests }),
						updateStates: (updates) => updatePullRequestStates({ updates })
					}
				: null,
		[localApi, authReady, signedInUserId, updatePullRequestStates]
	);

	const pullRequestRefresher = usePullRequestRefresher(pullRequestStateSync);

	const selectedThreadRows = useMemo(
		() => (currentActiveThread ? [currentActiveThread] : []),
		[currentActiveThread]
	);

	useShownPullRequests(pullRequestRefresher, selectedThreadRows);

	const runState = currentLifecycle?.run ?? null;
	const pendingAgentQuestion = dataForThread(pendingAgentQuestionQuery.data, currentThreadId);

	useEffect(() => {
		const threadId = currentThreadId;

		if (transcript.threadId !== threadId) transcript.selectThread(threadId);
	}, [currentThreadId, transcript]);

	useEffect(() => {
		const threadId = currentThreadId;
		const api = localApi;

		if (!threadId || !api || !isSignedIn) return;
		const userId = signedInUserIdRef.current;

		if (!userId) return;

		return transcript.watchDisplay({
			api,
			userId,
			threadId,
			isCurrent: () => currentThreadIdRef.current === threadId
		});
	}, [currentThreadId, localApi, isSignedIn, transcript, signedInUserId]);

	useEffect(() => {
		const threadId = currentThreadId;
		const api = localApi;

		if (!threadId || !api || !isSignedIn) return;
		const userId = signedInUserIdRef.current;

		if (!userId) return;

		return transcript.watchLiveCompletion({
			api,
			userId,
			threadId,
			isCurrent: () => currentThreadIdRef.current === threadId
		});
	}, [currentThreadId, localApi, isSignedIn, transcript, signedInUserId]);

	const currentThreadIdRef = useRef(currentThreadId);
	const currentWorkspacePathRef = useRef(currentWorkspacePath);
	const currentRepositoryKeyRef = useRef(currentRepositoryKey);
	const draftWorkspacePathRef = useRef(draftWorkspacePath);

	useEffect(() => {
		transcript.syncOverlays(transcript.overlays);
	});

	const visibleMessages = transcript.visibleMessages({
		threadId: currentThreadId,
		userId: signedInUserId
	});

	const currentProject = useMemo<ProjectState | null>(() => {
		if (currentWorkspacePath) {
			return findProjectByWorkspacePath(projects, currentWorkspacePath);
		}

		if (!currentRepositoryKey) return null;

		return findProjectByRepositoryKey(projects, currentRepositoryKey);
	}, [projects, currentWorkspacePath, currentRepositoryKey]);

	const currentProjectPath = currentProject?.workspacePath ?? currentWorkspacePath;

	const composerProjectPaths = useMemo(() => {
		if (!currentProjectPath || !localApi) return null;

		return {
			workspacePath: currentProjectPath,
			search: (query: string, signal: AbortSignal) =>
				localApi.searchWorkspace({ workspacePath: currentProjectPath, query }, signal)
		};
	}, [currentProjectPath, localApi]);

	const threadCwd = useExistingThreadCwd(
		localApi,
		currentActiveThread?.cwd,
		currentActiveThread?.status
	);

	const projectWorkspacePath = currentProject?.workspacePath;

	const markdownFileLinks = useMemo<MarkdownFileLinks | null>(() => {
		const roots = [threadCwd, projectWorkspacePath].filter((root): root is string => !!root);

		if (!localApi) return null;

		return {
			roots,
			open: (target) => {
				artifactPanel.setFullscreenKey(null);
				void openMarkdownLink(target, {
					roots,
					entryKind: (entry) => localApi.workspaceEntryKind(entry),
					openFile: (file) => artifactPanel.openFile(file),
					openDirectory: (directory) => artifactPanel.openDirectory(directory)
				});
			}
		};
	}, [localApi, threadCwd, projectWorkspacePath, artifactPanel]);

	const composerProjectSkills = useMemo(() => {
		const workspacePath = currentProject?.workspacePath ?? null;
		const api = localApi;

		return {
			workspacePath,
			load: async () => {
				if (!api || !workspacePath) return [];
				const result = await api.listWorkspaceSkills({ workspacePath });

				for (const warning of result.warnings) {
					console.warn(`sprocket skills: ${warning}`);
				}

				return result.skills;
			}
		};
	}, [currentProject, localApi]);

	const currentProjectThreads = useMemo<ThreadSummary[]>(() => {
		if (!currentProject?.repositoryKey) return [];

		return threads
			.filter(
				(thread) => thread.repositoryKey === currentProject.repositoryKey && isActiveThread(thread)
			)
			.sort((left, right) => right.lastMessageAt - left.lastMessageAt);
	}, [threads, currentProject]);

	const visibleActions = useMemo<ExecutorJob[]>(() => [], []);

	useEffect(() => {
		const scope =
			signedInUserId && currentRepositoryKey
				? {
						userId: signedInUserId,
						repositoryKey: currentRepositoryKey,
						workspacePath: currentWorkspacePath ?? ''
					}
				: null;

		artifactPanel.selectScope(scope);
	}, [artifactPanel, signedInUserId, currentRepositoryKey, currentWorkspacePath]);

	useEffect(() => {
		const scope =
			signedInUserId && currentRepositoryKey
				? {
						userId: signedInUserId,
						repositoryKey: currentRepositoryKey,
						workspacePath: currentWorkspacePath ?? ''
					}
				: null;

		return artifactPanel.watch({
			localApi,
			artifactClient,
			cloudReady: !convexAuth.isLoading && convexAuth.isAuthenticated,
			scope
		});
	}, [
		artifactPanel,
		signedInUserId,
		currentRepositoryKey,
		currentWorkspacePath,
		localApi,
		artifactClient,
		convexAuth.isLoading,
		convexAuth.isAuthenticated
	]);

	const deleteArtifact =
		currentRepositoryKey && convexAuth.isAuthenticated && !convexAuth.isLoading
			? async (artifactId: string) => {
					if (localApi && signedInUserId && currentWorkspacePath) {
						await localApi.deleteArtifact({
							userId: signedInUserId,
							repositoryKey: currentRepositoryKey,
							workspacePath: currentWorkspacePath,
							artifactId
						});

						return;
					}

					// SAFETY: artifact IDs come from the authenticated artifact registry.
					await deleteArtifactRecord({
						artifactId: artifactId as Id<'artifacts'>,
						repositoryKey: currentRepositoryKey
					});
				}
			: undefined;

	const currentComposerScope = getComposerScope(currentThreadId, currentProjectPath);

	const currentRecoveredSubmission = (() => {
		const userId = signedInUserIdRef.current;

		if (!userId || !currentComposerScope) return undefined;

		return recoveredSubmissionIds.get(getComposerRecoveryKey(userId, currentComposerScope));
	})();

	const isRetryableQueuedRun =
		currentLifecycle?.phase === 'queued' && currentRecoveredSubmission != null;

	const isRunInProgress =
		currentLifecycle != null &&
		isLifecycleInProgress(currentLifecycle.phase) &&
		!isRetryableQueuedRun;

	const isStopAvailable =
		runState != null &&
		((isRunInProgress && currentLifecycle?.phase !== 'cancellation_requested') ||
			(!isRunInProgress && pendingAgentQuestion != null));

	const hasPendingAgentLaunch = isAgentLaunchPending(pendingAgentLaunches, currentThreadId);

	const latestRunResumeKind =
		hasPendingAgentLaunch || isRunInProgress
			? null
			: lifecycleResumeKind(currentLifecycle?.phase ?? 'idle', currentLifecycle?.run?.failureKind);

	const isLatestRunReady = isLatestRunReadyForThread({
		threadId: currentThreadId,
		pendingCreatedThreadId,
		hasLatestRunData: Boolean(currentLifecycle)
	});

	const isSubmittingPrompt = Boolean(
		currentComposerScope && submittingPromptScopes.has(currentComposerScope)
	);

	const conversationError =
		(currentThreadId && transcript.threadId === currentThreadId ? transcript.error : null) ??
		currentError ??
		auth.error ??
		(queryError ? convexClientErrorMessage(queryError) : null);

	const runError =
		(latestRunResumeKind === 'failed' || latestRunResumeKind === 'crash') && !isSubmittingPrompt
			? (runState?.lastError ?? null)
			: null;

	const canSend = Boolean(
		currentProjectPath &&
		(pendingAgentQuestion || providersReady) &&
		currentProject?.localAttachmentAvailability === 'available' &&
		!isSubmittingPrompt &&
		!answeringAgentQuestion &&
		!hasPendingAgentLaunch &&
		((!isRunInProgress && isLatestRunReady) || pendingAgentQuestion)
	);

	const recentProjectDirectories = useMemo(() => {
		const seen = new Set<string>();
		const recents: Array<{ workspacePath: string; displayName: string }> = [];

		for (const attachment of orderedProjectAttachments) {
			if (attachment.availability !== 'available' || seen.has(attachment.workspacePath)) {
				continue;
			}

			seen.add(attachment.workspacePath);

			const displayName =
				attachment.workspacePath.split(/[/\\]/).filter(Boolean).at(-1) ?? attachment.workspacePath;

			recents.push({ workspacePath: attachment.workspacePath, displayName });
		}

		return recents;
	}, [orderedProjectAttachments]);

	function publishDesktopProjectAttachments(attachments: Record<string, ProjectAttachment>) {
		desktopProjectAttachmentsRef.current = attachments;
		setDesktopProjectAttachmentsByPath(attachments);
		setHasLoadedDesktopProjectAttachments(true);
	}

	async function refreshDesktopProjectAttachments(
		client = localApiRef.current
	): Promise<Record<string, ProjectAttachment>> {
		const refreshGeneration = ++desktopProjectAttachmentsGeneration.current;
		const selectedWorkspacePath = currentWorkspacePathRef.current;
		const selectionGeneration = projectSelectionGeneration.current;
		const nextAttachments = await refreshDesktopProjectAttachmentsFromDesktop(client);

		if (refreshGeneration !== desktopProjectAttachmentsGeneration.current) {
			return desktopProjectAttachmentsRef.current;
		}

		publishDesktopProjectAttachments(nextAttachments);

		if (!selectedWorkspacePath || selectionGeneration !== projectSelectionGeneration.current) {
			return nextAttachments;
		}

		let selectedAttachment: ProjectAttachment | undefined = nextAttachments[selectedWorkspacePath];

		if (!selectedAttachment && client) {
			const resolution = await client.resolveWorkspacePath({
				workspacePath: selectedWorkspacePath
			});

			if (
				refreshGeneration !== desktopProjectAttachmentsGeneration.current ||
				selectionGeneration !== projectSelectionGeneration.current
			) {
				return desktopProjectAttachmentsRef.current;
			}

			selectedAttachment = findCanonicalProjectAttachment(nextAttachments, resolution);
		}

		if (!selectedAttachment) return nextAttachments;

		const repositoryChanged = selectedAttachment.repositoryKey !== currentRepositoryKeyRef.current;

		if (selectedAttachment.workspacePath !== selectedWorkspacePath || repositoryChanged) {
			const draft = draftWorkspacePathRef.current === selectedWorkspacePath;
			bumpProjectSelectionGeneration();
			setCurrentWorkspacePath(selectedAttachment.workspacePath);
			setCurrentRepositoryKey(selectedAttachment.repositoryKey);
			setDraftWorkspacePath(draft ? selectedAttachment.workspacePath : null);

			if (repositoryChanged) {
				setCurrentThreadId(null);
				setPendingCreatedThreadId(null);
			}
		}

		return nextAttachments;
	}

	async function signOut() {
		const api = localApi;
		const userId = signedInUserIdRef.current;

		if (api && userId) {
			await api.endAccountSession({ userId }).catch(() => {});
		}

		await authSignOut();
	}

	const registerAccountSession = useEffectEvent((api: LocalApi, userId: string) => {
		void api.startAccountSession({ userId }).catch((error) => {
			if (localApiRef.current === api && signedInUserIdRef.current === userId) {
				setCurrentError(
					error instanceof Error ? error.message : 'Failed to register this Sprocket process.'
				);
			}
		});
	});

	useEffect(() => {
		if (!localApi || !signedInUserId || !authReady) return;
		registerAccountSession(localApi, signedInUserId);
	}, [localApi, signedInUserId, authReady]);

	function applyProjectSelection(
		workspacePath: string,
		threadId: Id<'threadRecords'> | null = null,
		draft = false,
		repositoryKey?: string
	) {
		const project = findProjectByWorkspacePath(projects, workspacePath);
		const nextRepositoryKey = repositoryKey ?? project?.repositoryKey ?? null;
		setCurrentWorkspacePath(workspacePath);
		setCurrentRepositoryKey(nextRepositoryKey);
		setCurrentThreadId(threadId);
		setDraftWorkspacePath(draft ? workspacePath : null);

		if (threadId !== pendingCreatedThreadId) {
			setPendingCreatedThreadId(null);
		}
	}

	function bumpProjectSelectionGeneration() {
		return ++projectSelectionGeneration.current;
	}

	function setProjectSelection(
		workspacePath: string,
		threadId: Id<'threadRecords'> | null = null,
		draft = false,
		preserveError = false,
		repositoryKey?: string
	) {
		const generation = bumpProjectSelectionGeneration();

		if (!preserveError) setCurrentError(null);
		applyProjectSelection(workspacePath, threadId, draft, repositoryKey);

		return generation;
	}

	async function attachLocalProject(
		workspacePath: string,
		replaceWorkspacePath?: string,
		client = localApiRef.current
	) {
		if (!client) {
			throw new Error(localServerRequiredMessage);
		}

		const attachment = await attachLocalProjectForPath({
			localApi: client,
			workspacePath,
			replaceWorkspacePath
		});

		desktopProjectAttachmentsGeneration.current += 1;
		publishDesktopProjectAttachments(
			upsertDesktopProjectAttachment(
				desktopProjectAttachmentsRef.current,
				attachment,
				replaceWorkspacePath
			)
		);

		return attachment;
	}

	async function prepareProjectRemoval(workspacePath: string, signal: AbortSignal) {
		const client = localApiRef.current;
		const userId = signedInUserIdRef.current;

		if (currentWorkspacePathRef.current === workspacePath) {
			await composerAttachments.waitForUploads(signal);
		}

		if (client !== localApiRef.current || userId !== signedInUserIdRef.current) {
			throw new Error('The connection or account changed. Please try again.');
		}
	}

	async function removeProject(workspacePath: string) {
		const client = localApiRef.current;
		const userId = signedInUserIdRef.current;

		if (!client || !userId) throw new Error(localServerRequiredMessage);

		await client.removeProject({ workspacePath });

		if (client !== localApiRef.current || userId !== signedInUserIdRef.current) return;

		desktopProjectAttachmentsGeneration.current += 1;

		const remaining = Object.fromEntries(
			Object.entries(desktopProjectAttachmentsRef.current).filter(
				([path]) => path !== workspacePath
			)
		);

		publishDesktopProjectAttachments(remaining);
		const attachedKeys = new Set(Object.values(remaining).map((project) => project.repositoryKey));
		setProjectFilter((keys) => keys.filter((key) => attachedKeys.has(key)));

		if (currentWorkspacePathRef.current === workspacePath) {
			const scope = getComposerScope(currentThreadIdRef.current, workspacePath);

			if (scope && (prompt || composerAttachments.items.length > 0)) {
				storeComposerRecovery(userId, scope, {
					message: '',
					prompt,
					attachments: composerAttachments.snapshot(),
					continuationOfRunId: composerContinuationOfRunIdRef.current ?? undefined,
					autoSubmit: false
				});
			}

			setPrompt('');
			composerAttachments.clear({ discard: false });
			bumpProjectSelectionGeneration();
			setCurrentWorkspacePath(null);
			setCurrentRepositoryKey(null);
			setCurrentThreadId(null);
			setDraftWorkspacePath(null);
			setPendingCreatedThreadId(null);
			setComposerContinuationOfRunId(null);
			setAutoSubmitComposerContinuation(false);
			setSelectedQuestionOptionId(null);
		}
	}

	function openProject(
		workspacePath: string,
		selection: { threadId?: Id<'threadRecords'> | null; draft?: boolean } = {}
	) {
		const project = findProjectByWorkspacePath(projects, workspacePath);

		if (!project) {
			setCurrentError('Choose a project first.');

			return;
		}

		const selectionGeneration = setProjectSelection(
			workspacePath,
			selection.threadId,
			selection.draft
		);

		void verifyProject(project.workspacePath).catch((error) => {
			if (selectionGeneration === projectSelectionGeneration.current) {
				setCurrentError(error instanceof Error ? error.message : 'Failed to attach project.');
			}
		});
	}

	function openProjectPicker(
		mode: 'add' | 'reconnect' = 'add',
		workspacePath: string | null = null
	) {
		if (!localApi) {
			setCurrentError(localServerRequiredMessage);

			return;
		}

		setProjectPickerMode(mode);
		setProjectPickerReconnectWorkspacePath(workspacePath);

		const reconnectProject =
			mode === 'reconnect' && workspacePath
				? findProjectByWorkspacePath(projects, workspacePath)
				: undefined;

		setProjectPickerExpectedDisplayName(reconnectProject?.displayName);
		setProjectPickerOpen(true);
		setCurrentError(null);
	}

	async function handleProjectSelected(selection: ProjectSelection) {
		if (!localApi) {
			setCurrentError(localServerRequiredMessage);

			return;
		}

		const pickerUserId = signedInUserIdRef.current;

		if (!pickerUserId) {
			setCurrentError('User session is not ready.');

			return;
		}

		try {
			if (projectPickerMode === 'reconnect' && projectPickerReconnectWorkspacePath) {
				await reconnectProjectSelection(
					selection,
					projectPickerReconnectWorkspacePath,
					pickerUserId
				);

				return;
			}

			await addProjectSelection(selection, pickerUserId);
		} catch (error) {
			if (signedInUserIdRef.current !== pickerUserId) return;
			setCurrentError(error instanceof Error ? error.message : 'Failed to attach project.');
			throw error;
		}
	}

	async function addProjectSelection(
		selection: ProjectSelection,
		expectedUserId: string,
		client?: LocalApi
	) {
		const attachment = await attachLocalProject(selection.workspacePath, undefined, client);

		if (signedInUserIdRef.current !== expectedUserId) return;
		setProjectSelection(attachment.workspacePath, null, true, false, attachment.repositoryKey);
		setCurrentError(null);
	}

	async function reconnectProjectSelection(
		selection: ProjectSelection,
		previousWorkspacePath: string,
		expectedUserId: string,
		client?: LocalApi
	) {
		const previousProject = findProjectByWorkspacePath(projects, previousWorkspacePath);

		const attachment = await attachLocalProject(
			selection.workspacePath,
			previousWorkspacePath === selection.workspacePath ? undefined : previousWorkspacePath,
			client
		);

		if (signedInUserIdRef.current !== expectedUserId) return;

		const keepThread =
			previousProject?.repositoryKey === attachment.repositoryKey
				? currentThreadIdRef.current
				: null;

		setProjectSelection(
			attachment.workspacePath,
			keepThread,
			false,
			false,
			attachment.repositoryKey
		);
		setCurrentError(null);
	}

	function queueProjectLaunch(workspacePath: string | null | undefined) {
		const normalizedPath = workspacePath?.trim();

		if (!normalizedPath) return;
		setPendingProjectLaunches((launches) => [...launches, normalizedPath]);
	}

	async function takeDesktopProjectLaunches() {
		const bridge = window.sprocketDesktopBridge;

		if (!bridge?.takeWorkspaceLaunch) return;

		for (;;) {
			const workspacePath = await bridge.takeWorkspaceLaunch();

			if (!workspacePath) return;
			queueProjectLaunch(workspacePath);
		}
	}

	async function openLaunchedProject(workspacePath: string, client: LocalApi, userId: string) {
		const selection = await client.resolveWorkspacePath({ workspacePath });

		if (signedInUserIdRef.current !== userId) return;
		await addProjectSelection(selection, userId, client);
	}

	async function verifyProject(workspacePath: string) {
		await verifyProjectAttachmentForExecution({
			localApi,
			refreshDesktopProjectAttachments: async () => {
				await refreshDesktopProjectAttachments();
			},
			workspacePath
		});
	}

	function reconnectProject(workspacePath: string) {
		openProjectPicker('reconnect', workspacePath);
	}

	function handleProviderConfigurationChange(change: { provider: 'openai'; configured: boolean }) {
		providerConfigurationGeneration.current += 1;

		if (change.provider === 'openai') setOpenAiConfigured(change.configured);
		setProviderConfigurationReady(true);
		setProviderConfigurationError(null);
	}

	function handleChatGptStatusChange(status: ChatGptStatus) {
		chatGptStatusGeneration.current += 1;
		setChatGptStatusLoading(false);
		setChatGptStatus(status);
		setChatGptStatusError(status.error ?? null);

		const active = status.accounts.find(
			(account) => account.connectionId === status.activeConnectionId
		);

		setChatGptConfigured(active?.connected === true);
	}

	function startThreadDraftForProject(workspacePath: string) {
		openProject(workspacePath, { draft: true });
		void focusCreateThreadComposer();
	}

	function startThreadDraft() {
		const current = findProjectByWorkspacePath(projects, currentWorkspacePath);

		const project =
			(current?.localAttachmentAvailability === 'available' ? current : null) ??
			projects.find((candidate) => candidate.localAttachmentAvailability === 'available') ??
			projects[0];

		if (!project) {
			openProjectPicker('add');

			return;
		}

		startThreadDraftForProject(project.workspacePath);

		if (matchMedia('(max-width: 767px)').matches) setSidebarOpen(false);
	}

	async function focusCreateThreadComposer() {
		await Promise.resolve();
		createThreadComposerElement?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
	}

	function selectThread(thread: ThreadSummary, workspacePath: string) {
		openProject(workspacePath, { threadId: thread.threadId });
	}

	function selectInboxThread(thread: Doc<'threadRecords'>) {
		const project = findProjectByRepositoryKey(projects, thread.repositoryKey);

		if (!project) return;
		selectThread(threadRecordToSummary(thread), project.workspacePath);

		if (matchMedia('(max-width: 767px)').matches) setSidebarOpen(false);
	}

	async function renameThread(threadId: Id<'threadRecords'>, title: string) {
		try {
			await renameThreadRecord({ threadId, title });
		} catch (error) {
			setCurrentError(error instanceof Error ? error.message : 'Failed to rename thread.');
			throw error;
		}
	}

	async function regenerateThreadTitle(threadId: Id<'threadRecords'>) {
		try {
			await regenerateThreadTitleRecord({ threadId });
		} catch (error) {
			setCurrentError(
				error instanceof Error ? error.message : 'Failed to regenerate thread title.'
			);
			throw error;
		}
	}

	async function loadOlderTranscript() {
		await transcript.loadOlder();
	}

	async function loadTranscriptAttachment(storageId: Id<'_storage'>) {
		const api = localApi;
		const threadId = currentThreadId;
		const userId = signedInUserIdRef.current;

		if (!api || !threadId || !userId) return null;
		const blob = await api.fetchTranscriptAttachment({ userId, threadId, storageId });

		return blob ? URL.createObjectURL(blob) : null;
	}

	async function loadTranscriptSectionDetails(
		row: TranscriptDisplayRow,
		cursor: TranscriptDetailCursor,
		signal: AbortSignal
	) {
		const api = localApi;
		const threadId = currentThreadId;
		const userId = signedInUserIdRef.current;

		if (!api || !threadId || !userId || row.threadId !== threadId) {
			throw new Error('Thread is no longer selected.');
		}

		return await api.fetchTranscriptDisplayDetails(
			{ userId, threadId, rowId: row.id, ...cursor },
			signal
		);
	}

	async function changeInboxState(thread: Doc<'threadRecords'>, state: InboxState) {
		const expectedUserId = signedInUserIdRef.current;

		try {
			const request = { threadId: thread._id };

			if (state === 'settled') await settleThreadRecord(request);
			else await unsettleThreadRecord(request);

			if (signedInUserIdRef.current === expectedUserId) {
				if (state === 'settled' && currentThreadIdRef.current === thread._id) {
					setCurrentThreadId(null);
					setDraftWorkspacePath(currentWorkspacePathRef.current);
					bumpProjectSelectionGeneration();
				}

				setCurrentError(null);
			}
		} catch (error) {
			if (signedInUserIdRef.current !== expectedUserId) return;
			setCurrentError(error instanceof Error ? error.message : 'Failed to update thread.');
			throw error;
		}
	}

	async function submitAgentQuestionAnswer() {
		const question = pendingAgentQuestion;
		const threadId = currentThreadId;
		const userId = signedInUserIdRef.current;

		if (!question || !threadId || !userId || answeringAgentQuestion) return;

		if (!selectedQuestionOptionId && !prompt.trim()) return;

		setAnsweringAgentQuestion(true);
		setCurrentError(null);
		const submittedPrompt = prompt;
		const submittedOptionId = selectedQuestionOptionId;
		const answerText = submittedPrompt.trim();
		const submittedAttachments = composerAttachments.snapshot();

		const submittedStorageIds = submittedAttachments.flatMap((attachment) =>
			attachment.storageId ? [attachment.storageId] : []
		);

		const submittedModel = selectedModel;
		const submittedCompletionProvider = currentProvider;
		const submittedProvidersReady = providersReady;
		const submittedReasoningEffort = selectedReasoningEffort;
		const submittedFastMode = fastMode;
		let continuationPrompt: string | null = null;
		let continuationOfRunId: Id<'runs'> | undefined;
		setPrompt('');
		setSelectedQuestionOptionId(null);

		try {
			const answer = {
				threadId,
				questionId: question.questionId,
				optionId: submittedOptionId ?? undefined,
				text: answerText || undefined
			};

			const result = await answerAgentQuestion(answer);

			if (result.continuation) {
				continuationPrompt = result.continuation.prompt;
				continuationOfRunId = result.continuation.runId;
			}
		} catch (error) {
			if (
				signedInUserIdRef.current === userId &&
				currentThreadIdRef.current === threadId &&
				pendingAgentQuestionRef.current?.questionId === question.questionId
			) {
				setPrompt(submittedPrompt);
				setSelectedQuestionOptionId(submittedOptionId);
				setCurrentError(error instanceof Error ? error.message : String(error));
			}
		} finally {
			if (signedInUserIdRef.current === userId) setAnsweringAgentQuestion(false);
		}

		if (signedInUserIdRef.current !== userId) return;

		if (continuationPrompt !== null && currentThreadIdRef.current !== threadId) {
			storeComposerRecovery(userId, `thread:${threadId}`, {
				message: 'Continuing from your answer when you return to this thread.',
				prompt: continuationPrompt,
				attachments: submittedAttachments,
				storageIds: submittedStorageIds,
				reasoningEffort: submittedReasoningEffort,
				fastMode: submittedFastMode,
				selectedModel: submittedModel,
				completionProvider: submittedCompletionProvider,
				continuationOfRunId,
				autoSubmit: true
			});

			return;
		}

		if (continuationPrompt !== null) {
			setComposerContinuationOfRunId(continuationOfRunId ?? null);
			setPrompt(continuationPrompt);

			if (!submittedProvidersReady) {
				setAutoSubmitComposerContinuation(true);

				return;
			}

			await submitPrompt(
				{ answeredQuestionId: question.questionId, continuationOfRunId },
				continuationPrompt
			);
		}
	}

	const pendingAgentQuestionRef = useRef(pendingAgentQuestion);

	async function submitPrompt(
		options?: {
			answeredQuestionId: Id<'agentQuestions'>;
			continuationOfRunId: Id<'runs'> | undefined;
		},
		promptOverride?: string
	) {
		const currentQuestion = pendingAgentQuestionRef.current;

		if (currentQuestion) {
			if (
				options?.answeredQuestionId &&
				currentQuestion.questionId !== options.answeredQuestionId
			) {
				setCurrentError('Answer the new agent question before continuing.');

				return;
			}

			if (!options?.answeredQuestionId) {
				await submitAgentQuestionAnswer();

				return;
			}
		}

		const promptText = promptOverride ?? prompt;

		if (isSubmittingPrompt) return;

		if (!promptText.trim() && composerAttachments.items.length === 0) return;

		if (composerAttachments.items.some((attachment) => attachment.status !== 'ready')) {
			setCurrentError('Wait for file uploads to finish, or remove failed files before sending.');

			return;
		}

		let workspacePath = currentProjectPath;

		if (!workspacePath) {
			setCurrentError('Choose a project first.');

			return;
		}

		if (!localApi) {
			setCurrentError(localServerRequiredMessage);

			return;
		}

		if (!selectedModel || !selectedReasoningEffort) return;

		if (currentThreadId && !isLatestRunReady) {
			setCurrentError('Loading thread state before sending.');

			return;
		}

		if (!canSend) {
			setCurrentError(
				isRunInProgress || hasPendingAgentLaunch || isSubmittingPrompt
					? 'Wait for the current agent launch or run to finish.'
					: currentProject?.localAttachmentAvailability === 'available'
						? 'You need an active project before sending.'
						: 'This project needs to be attached before sending.'
			);

			return;
		}

		if (!currentProvider) {
			setCurrentError(noProviderMessage);

			return;
		}

		const selectedThreadId = currentThreadId;
		let submittedRepositoryKey = currentRepositoryKey;

		if (!submittedRepositoryKey) {
			setCurrentError('Choose a project first.');

			return;
		}

		const submittedUserId = signedInUserIdRef.current;

		if (!submittedUserId) {
			setCurrentError('User session is not ready.');

			return;
		}

		const isSubmittedUserCurrent = () => signedInUserIdRef.current === submittedUserId;
		const submittedPrompt = promptText.trim();
		const submittedAttachments = composerAttachments.snapshot();

		const submittedStorageIds = submittedAttachments.flatMap((attachment) =>
			attachment.storageId ? [attachment.storageId] : []
		);

		const submittedModel = selectedModel;
		const submittedCompletionProvider = currentProvider;
		const submittedReasoningEffort = selectedReasoningEffort;
		const submittedFastMode = fastMode;

		const submittedContinuationOfRunId =
			options?.continuationOfRunId ?? composerContinuationOfRunId ?? undefined;

		const previousRunId = selectedThreadId ? (runState?.runId ?? null) : null;

		let submissionScope = selectedThreadId
			? `thread:${selectedThreadId}`
			: `draft:${workspacePath}`;

		const originatingRecoveryScope = submissionScope;
		let recoveryScope = originatingRecoveryScope;

		const originatingRecoveryKey = getComposerRecoveryKey(
			submittedUserId,
			originatingRecoveryScope
		);

		const recoveredSubmission = recoveredSubmissionIds.get(originatingRecoveryKey);
		const freshSubmissionId = crypto.randomUUID();

		const threadSubmissionId = resolveSubmissionId({
			latestRun:
				!selectedThreadId || !currentLifecycle || currentLifecycle.phase === 'idle'
					? null
					: {
							runId: runState?.runId,
							status: isLifecycleInProgress(currentLifecycle.phase) ? 'queued' : 'completed',
							submissionId: currentRecoveredSubmission?.submissionId ?? ''
						},
			newSubmissionId: freshSubmissionId,
			prompt: submittedPrompt,
			storageIds: submittedStorageIds,
			reasoningEffort: submittedReasoningEffort,
			fastMode: submittedFastMode,
			completionProvider: submittedCompletionProvider,
			continuationOfRunId: submittedContinuationOfRunId,
			recoveredSubmission: recoveredSubmission
				? { ...recoveredSubmission, selectedModel: recoveredSubmission.selectedModel }
				: undefined,
			selectedModel: submittedModel
		});

		const runSubmissionId = threadSubmissionId;
		clearComposerRecovery(submittedUserId, originatingRecoveryScope);
		let launchedThreadId: Id<'threadRecords'> | null = null;
		let agentLaunchId: number | null = null;
		const submissionSequence = ++nextSubmissionSequence.current;
		let submissionTrackingKey = getComposerRecoveryKey(submittedUserId, originatingRecoveryScope);
		latestSubmissionSequencesByRecoveryScope.set(submissionTrackingKey, submissionSequence);

		const isSubmissionCurrent = () =>
			latestSubmissionSequencesByRecoveryScope.get(submissionTrackingKey) === submissionSequence;

		const sessionChangedMessage =
			'Your session changed before the agent started. Return to this account and send the prompt again.';

		const submissionDelayMessage =
			'This request is still preparing. Wait for it to finish before trying again.';

		const recoverSubmission = (message: string | null, submissionId?: string) => {
			storeComposerRecovery(submittedUserId, recoveryScope, {
				message,
				prompt: submittedPrompt,
				attachments: submittedAttachments,
				storageIds: submittedStorageIds,
				reasoningEffort: submittedReasoningEffort,
				fastMode: submittedFastMode,
				selectedModel: submittedModel,
				completionProvider: submittedCompletionProvider,
				continuationOfRunId: submittedContinuationOfRunId,
				autoSubmit: false,
				submissionId:
					submissionId ??
					(!selectedThreadId && recoveryScope === originatingRecoveryScope
						? threadSubmissionId
						: runSubmissionId)
			});
		};

		const clearSubmissionDelay = () => {
			clearComposerRecovery(submittedUserId, recoveryScope);

			if (isSubmittedUserCurrent()) {
				setCurrentError((error) => (error === submissionDelayMessage ? null : error));
			}
		};

		const submissionTimeoutId = window.setTimeout(() => {
			if (
				latestSubmissionSequencesByRecoveryScope.get(submissionTrackingKey) !== submissionSequence
			) {
				return;
			}

			recoverSubmission(submissionDelayMessage);
			const pendingThreadId = launchedThreadId;
			const pendingLaunchId = agentLaunchId;

			if (pendingThreadId && pendingLaunchId !== null) {
				setPendingAgentLaunches((launches) =>
					clearPendingAgentLaunch(launches, pendingThreadId, pendingLaunchId)
				);
			}

			clearSubmittingPrompt(submissionScope, submissionSequence);
			latestSubmissionSequencesByRecoveryScope.delete(submissionTrackingKey);
		}, agentLaunchTimeoutMs);

		setPrompt('');
		setCurrentError(null);
		submittingPromptScopes.set(submissionScope, submissionSequence);
		bumpSubmissionTracking();

		try {
			if (!selectedThreadId) {
				const resolution = await localApi.resolveWorkspacePath({ workspacePath });

				if (!isSubmissionCurrent()) return;

				if (resolution.repositoryKey !== submittedRepositoryKey) {
					const nextAttachments = await refreshDesktopProjectAttachments();

					if (!isSubmissionCurrent()) return;
					const canonicalAttachment = findCanonicalProjectAttachment(nextAttachments, resolution);

					if (!canonicalAttachment) {
						throw new Error('The repository changed and its project attachment is unavailable.');
					}

					workspacePath = canonicalAttachment.workspacePath;
					submittedRepositoryKey = canonicalAttachment.repositoryKey;
					setProjectSelection(workspacePath, null, true, true, submittedRepositoryKey);

					const nextSubmissionScope = `draft:${workspacePath}`;

					if (nextSubmissionScope !== submissionScope) {
						clearSubmittingPrompt(submissionScope, submissionSequence);
						latestSubmissionSequencesByRecoveryScope.delete(submissionTrackingKey);
						submissionScope = nextSubmissionScope;
						recoveryScope = nextSubmissionScope;
						submissionTrackingKey = getComposerRecoveryKey(submittedUserId, nextSubmissionScope);
						latestSubmissionSequencesByRecoveryScope.set(submissionTrackingKey, submissionSequence);
						submittingPromptScopes.set(submissionScope, submissionSequence);
						bumpSubmissionTracking();
					}
				}
			}

			const threadId = selectedThreadId;

			if (!isSubmissionCurrent()) return;

			if (!isSubmittedUserCurrent()) {
				recoverSubmission(sessionChangedMessage);

				return;
			}

			launchedThreadId = threadId;
			clearSubmissionDelay();
			window.clearTimeout(submissionTimeoutId);
			const launchId = ++nextAgentLaunchId.current;
			agentLaunchId = launchId;

			const launch: PendingAgentLaunch = {
				launchId,
				previousRunId
			};

			if (runState?.startedAt) launch.previousStartedAt = runState.startedAt;

			if (threadId) {
				setPendingAgentLaunches((launches) => beginPendingAgentLaunch(launches, threadId, launch));
			}

			const clearLaunch = () => {
				if (!threadId) return;

				const nextPendingAgentLaunches = clearPendingAgentLaunch(
					pendingAgentLaunchesRef.current,
					threadId,
					launchId
				);

				if (nextPendingAgentLaunches !== pendingAgentLaunchesRef.current) {
					setPendingAgentLaunches(nextPendingAgentLaunches);
				}
			};

			await launchAgentRun({
				userId: submittedUserId,
				localApi,
				onError: (error) => {
					if (!isSubmissionCurrent() || !isSubmittedUserCurrent()) return;
					clearLaunch();
					// The server answered, so any run it created has already failed.
					recoverSubmission(
						error instanceof Error ? error.message : 'Failed to start the local agent run.',
						error instanceof LocalResponseError ? crypto.randomUUID() : undefined
					);
				},
				onStopped: () => {
					if (!isSubmissionCurrent() || !isSubmittedUserCurrent()) return;
					clearLaunch();
					recoverSubmission(null, crypto.randomUUID());
				},
				onStarted: (_runId, createdThreadId) => {
					if (isSubmittedUserCurrent()) {
						void refreshDesktopProjectAttachments().catch(() => {});
					}

					if (!isSubmissionCurrent() || !isSubmittedUserCurrent()) return;
					launchedThreadId = createdThreadId;

					if (
						currentThreadIdRef.current !== selectedThreadId ||
						currentWorkspacePathRef.current !== workspacePath
					)
						return;

					if (!selectedThreadId) {
						setPendingCreatedThreadId(createdThreadId);
						bumpProjectSelectionGeneration();
						setCurrentThreadId(createdThreadId);
						setDraftWorkspacePath(null);
					}

					composerAttachments.clear({ discard: false });

					if (composerContinuationOfRunIdRef.current === submittedContinuationOfRunId) {
						setComposerContinuationOfRunId(null);
						setAutoSubmitComposerContinuation(false);
					}
				},
				threadId: threadId ?? undefined,
				repositoryKey: threadId ? undefined : submittedRepositoryKey,
				prompt: submittedPrompt,
				storageIds: submittedStorageIds,
				selectedModel: submittedModel,
				completionProvider: submittedCompletionProvider,
				submissionId: runSubmissionId,
				reasoningEffort: submittedReasoningEffort,
				fastMode: submittedFastMode,
				workspacePath,
				continuationOfRunId: submittedContinuationOfRunId
			});
		} catch (error) {
			if (launchedThreadId && agentLaunchId !== null) {
				setPendingAgentLaunches(
					clearPendingAgentLaunch(pendingAgentLaunchesRef.current, launchedThreadId, agentLaunchId)
				);
			}

			if (!isSubmissionCurrent()) return;

			if (!isSubmittedUserCurrent()) {
				recoverSubmission(sessionChangedMessage);

				return;
			}

			recoverSubmission(error instanceof Error ? error.message : 'Failed to send prompt.');
			void refreshDesktopProjectAttachments().catch(() => {});
		} finally {
			window.clearTimeout(submissionTimeoutId);
			clearSubmittingPrompt(submissionScope, submissionSequence);

			if (
				agentLaunchId === null &&
				latestSubmissionSequencesByRecoveryScope.get(submissionTrackingKey) === submissionSequence
			) {
				latestSubmissionSequencesByRecoveryScope.delete(submissionTrackingKey);
			}
		}
	}

	const runStateRef = useRef(runState);
	const pendingAgentLaunchesRef = useRef(pendingAgentLaunches);
	const composerContinuationOfRunIdRef = useRef(composerContinuationOfRunId);

	// Async callbacks observe committed selections, never an abandoned render.
	useLayoutEffect(() => {
		configRef.current = config;
		signedInUserIdRef.current = signedInUserId;
		localApiRef.current = localApi;
		currentThreadIdRef.current = currentThreadId;
		currentWorkspacePathRef.current = currentWorkspacePath;
		currentRepositoryKeyRef.current = currentRepositoryKey;
		draftWorkspacePathRef.current = draftWorkspacePath;
		pendingAgentQuestionRef.current = pendingAgentQuestion;
		runStateRef.current = runState;
		pendingAgentLaunchesRef.current = pendingAgentLaunches;
		composerContinuationOfRunIdRef.current = composerContinuationOfRunId;
	}, [
		config,
		signedInUserId,
		localApi,
		currentThreadId,
		currentWorkspacePath,
		currentRepositoryKey,
		draftWorkspacePath,
		pendingAgentQuestion,
		runState,
		pendingAgentLaunches,
		composerContinuationOfRunId
	]);

	async function cancelRun() {
		if (!isStopAvailable) return;
		const expectedUserId = signedInUserIdRef.current;
		const expectedThreadId = currentThreadId;
		const expectedRunId = runState?.runId;

		if (!expectedThreadId || !expectedRunId) return;

		try {
			await convexClient.mutation(api.agentRuntime.requestCancellation, {
				runId: expectedRunId
			});
		} catch (error) {
			if (
				signedInUserIdRef.current !== expectedUserId ||
				currentThreadIdRef.current !== expectedThreadId ||
				runStateRef.current?.runId !== expectedRunId
			)
				return;
			setCurrentError(error instanceof Error ? error.message : 'Failed to stop run.');
		}
	}

	async function continueWorking() {
		if (
			!latestRunResumeKind ||
			!runState ||
			!currentThreadId ||
			!currentProjectPath ||
			!selectedModel ||
			!selectedReasoningEffort ||
			!providersReady ||
			hasPendingAgentLaunch ||
			isSubmittingPrompt
		) {
			return;
		}

		if (!localApi) {
			setCurrentError(localServerRequiredMessage);

			return;
		}

		if (!currentProvider) {
			setCurrentError(noProviderMessage);

			return;
		}

		const threadId = currentThreadId;
		const workspacePath = currentProjectPath;
		const userId = signedInUserIdRef.current;

		if (!workspacePath || !userId) return;
		const previousRunId = runState.runId;
		const previousStartedAt = runState.startedAt;
		const launchId = ++nextAgentLaunchId.current;

		const launch: PendingAgentLaunch = {
			launchId,
			previousRunId,
			previousStartedAt
		};

		setPendingAgentLaunches((launches) => beginPendingAgentLaunch(launches, threadId, launch));

		try {
			if (signedInUserIdRef.current !== userId) {
				throw new Error('User session is not ready.');
			}

			await launchAgentRun({
				userId,
				localApi,
				onError: (error) => {
					setPendingAgentLaunches((launches) =>
						clearPendingAgentLaunch(launches, threadId, launchId)
					);

					if (signedInUserIdRef.current !== userId || currentThreadIdRef.current !== threadId)
						return;
					setCurrentError(error.message);
				},
				onStarted: () => {},
				onStopped: () => {
					setPendingAgentLaunches((launches) =>
						clearPendingAgentLaunch(launches, threadId, launchId)
					);
				},
				threadId,
				prompt: '',
				storageIds: [],
				selectedModel,
				completionProvider: currentProvider,
				reasoningEffort: selectedReasoningEffort,
				fastMode,
				submissionId: crypto.randomUUID(),
				workspacePath,
				continuationOfRunId: previousRunId
			});
		} catch (error) {
			setPendingAgentLaunches((launches) => clearPendingAgentLaunch(launches, threadId, launchId));

			if (signedInUserIdRef.current !== userId || currentThreadIdRef.current !== threadId) return;
			setCurrentError(error instanceof Error ? error.message : 'Failed to continue the run.');
		}
	}

	// Reset per-user state when the signed-in user changes.
	const resetForSignedInUser = useEffectEvent((userId: string | null) => {
		const previousUserId = selectionUserId;
		const previousThreadId = currentThreadId;
		setSelectionUserId(userId);
		setHasResolvedInitialSelection(false);
		setCurrentWorkspacePath(null);
		setCurrentRepositoryKey(null);
		setCurrentThreadId(null);
		setDraftWorkspacePath(null);
		setPendingCreatedThreadId(null);
		setPendingAgentLaunches({});
		ensureSubscriptionAttemptedFor.current = null;
		providerConfigurationLoadedFor.current = null;
		setOpenAiConfigured(false);
		setChatGptConfigured(false);
		setChatGptStatus(null);
		setChatGptStatusLoading(false);
		setChatGptStatusError(null);
		chatGptStatusLoadedFor.current = null;
		setProviderConfigurationReady(false);
		setProviderConfigurationError(null);
		lastSyncedComposerThreadId.current = null;
		bumpProjectSelectionGeneration();
		setPrompt('');
		setAnsweringAgentQuestion(false);
		setSelectedQuestionOptionId(null);
		setComposerContinuationOfRunId(null);
		setAutoSubmitComposerContinuation(false);
		composerAttachments.clear({
			discard: true,
			userId: previousUserId,
			threadId: previousThreadId
		});
		setCurrentError(null);
		setSelectedModel(modelCatalog?.defaultModelId);
		setSelectedReasoningEffort(modelCatalog?.defaultReasoningEffort);
		setFastMode(false);
		setProjectPickerOpen(false);
		setProjectToRemove(null);
		setProjectPickerReconnectWorkspacePath(null);
		setProjectPickerExpectedDisplayName(undefined);
		artifactPanel.reset();
	});

	useEffect(() => {
		if (selectionUserId === signedInUserId) return;
		resetForSignedInUser(signedInUserId);
	}, [signedInUserId, selectionUserId]);

	useEffect(() => {
		if (!pendingCreatedThreadId) return;

		const nextPendingCreatedThreadId = resolvePendingCreatedThreadId({
			pendingCreatedThreadId,
			threads
		});

		if (nextPendingCreatedThreadId !== pendingCreatedThreadId) {
			setPendingCreatedThreadId(nextPendingCreatedThreadId);
		}
	}, [pendingCreatedThreadId, threads]);

	const startPendingProjectLaunch = useEffectEvent(
		(workspacePath: string, client: LocalApi, userId: string) => {
			setPendingProjectLaunches((launches) => launches.slice(1));
			setProjectLaunchInFlight(true);
			setHasResolvedInitialSelection(true);
			setProjectPickerOpen(false);
			setSettingsOpen(false);
			setCurrentError(null);
			void openLaunchedProject(workspacePath, client, userId)
				.catch((error) => {
					if (signedInUserIdRef.current === userId) {
						setHasResolvedInitialSelection(false);
						setCurrentError(
							error instanceof Error ? error.message : 'Failed to open the requested project.'
						);
					}
				})
				.finally(() => {
					setProjectLaunchInFlight(false);
				});
		}
	);

	useEffect(() => {
		const workspacePath = pendingProjectLaunches[0];

		if (
			!workspacePath ||
			projectLaunchInFlight ||
			!authReady ||
			!localApi ||
			!signedInUserId ||
			!hasLoadedDesktopProjectAttachments
		) {
			return;
		}

		startPendingProjectLaunch(workspacePath, localApi, signedInUserId);
	}, [
		pendingProjectLaunches,
		projectLaunchInFlight,
		localApi,
		signedInUserId,
		authReady,
		hasLoadedDesktopProjectAttachments
	]);

	useEffect(() => {
		const thread = currentActiveThread;
		const threadId = thread?._id ?? null;

		if (threadId === lastSyncedComposerThreadId.current) return;
		lastSyncedComposerThreadId.current = threadId;
		setComposerContinuationOfRunId(null);
		setAutoSubmitComposerContinuation(false);

		if (!thread) return;
		setSelectedModel(thread.selectedModel);
		setSelectedReasoningEffort(thread.reasoningEffort);
		setFastMode(thread.fastMode ?? false);
	}, [currentActiveThread]);

	useEffect(() => {
		const userId = signedInUserId;
		const recoveryScope = getComposerScope(currentThreadId, currentProjectPath);

		if (!userId || !recoveryScope) return;
		const recoveryKey = getComposerRecoveryKey(userId, recoveryScope);
		const recovery = composerRecoveries.get(recoveryKey);

		if (!recovery) return;

		if (recovery.autoSubmit && prompt !== '' && prompt !== recovery.prompt) return;

		composerRecoveries.delete(recoveryKey);
		const canRestorePrompt = prompt === '';

		if (canRestorePrompt) setPrompt(recovery.prompt);

		if (
			composerAttachments.items.length === 0 &&
			recovery.attachments?.length &&
			(canRestorePrompt || prompt === recovery.prompt)
		) {
			composerAttachments.replace(recovery.attachments);
		}

		if (prompt === recovery.prompt || canRestorePrompt) {
			setComposerContinuationOfRunId(recovery.continuationOfRunId ?? null);
			setAutoSubmitComposerContinuation(
				recovery.autoSubmit === true && recovery.continuationOfRunId !== undefined
			);

			if (
				recovery.submissionId &&
				(recovery.prompt || recovery.storageIds?.length) &&
				recovery.reasoningEffort &&
				recovery.selectedModel &&
				recovery.completionProvider
			) {
				recoveredSubmissionIds.set(recoveryKey, {
					prompt: recovery.prompt,
					storageIds: recovery.storageIds ?? [],
					reasoningEffort: recovery.reasoningEffort,
					fastMode: recovery.fastMode ?? false,
					selectedModel: recovery.selectedModel,
					completionProvider: recovery.completionProvider,
					submissionId: recovery.submissionId,
					continuationOfRunId: recovery.continuationOfRunId
				});
			}
		}

		setCurrentError(recovery.message);
		bumpSubmissionTracking();
	}, [
		signedInUserId,
		currentThreadId,
		currentProjectPath,
		prompt,
		composerAttachments,
		composerRecoveries,
		recoveredSubmissionIds,
		submissionTrackingVersion,
		bumpSubmissionTracking
	]);

	// Auto-submit only fires once per restored continuation: the flag is cleared
	// before the submission starts.
	const submitRestoredContinuation = useEffectEvent(() => {
		void submitPrompt();
	});

	useEffect(() => {
		if (
			!autoSubmitComposerContinuation ||
			!composerContinuationOfRunId ||
			!canSend ||
			pendingAgentQuestion ||
			!localApi ||
			!prompt.trim() ||
			composerAttachments.items.some((attachment) => attachment.status !== 'ready')
		) {
			return;
		}

		setAutoSubmitComposerContinuation(false);
		submitRestoredContinuation();
	}, [
		autoSubmitComposerContinuation,
		composerContinuationOfRunId,
		canSend,
		pendingAgentQuestion,
		localApi,
		prompt,
		composerAttachments
	]);

	const adoptInitialDraftSelection = useEffectEvent((workspacePath: string | null) => {
		setHasResolvedInitialSelection(true);

		if (!workspacePath) return;
		const selectionGeneration = setProjectSelection(workspacePath, null, true, true);
		void verifyProject(workspacePath).catch((error) => {
			if (selectionGeneration === projectSelectionGeneration.current) {
				setCurrentError(error instanceof Error ? error.message : 'Failed to attach project.');
			}
		});
		void focusCreateThreadComposer();
	});

	useEffect(() => {
		const selection = resolveInitialDraftSelection({
			hasResolvedInitialSelection,
			initialProjectLaunchResolved,
			hasPendingProjectLaunches: pendingProjectLaunches.length > 0,
			projectLaunchInFlight,
			hasLoadedProjects: hasLoadedDesktopProjectAttachments,
			signedInUserId,
			projects
		});

		if (!selection) return;
		adoptInitialDraftSelection(selection.workspacePath);
	}, [
		hasResolvedInitialSelection,
		initialProjectLaunchResolved,
		pendingProjectLaunches.length,
		projectLaunchInFlight,
		hasLoadedDesktopProjectAttachments,
		signedInUserId,
		projects
	]);

	const syncWorkspaceToThread = useEffectEvent((threadProject: ProjectState) => {
		setProjectSelection(
			threadProject.workspacePath,
			currentThreadId,
			draftWorkspacePath === threadProject.workspacePath
		);
	});

	useEffect(() => {
		const activeThreadSummary = currentThreadId ? findThreadById(threads, currentThreadId) : null;

		const threadProject =
			currentProject?.repositoryKey === activeThreadSummary?.repositoryKey
				? currentProject
				: findProjectByRepositoryKey(projects, activeThreadSummary?.repositoryKey);

		if (threadProject && threadProject.workspacePath !== currentWorkspacePath) {
			syncWorkspaceToThread(threadProject);
		}
	}, [
		threads,
		currentProject,
		currentThreadId,
		currentWorkspacePath,
		projects,
		draftWorkspacePath
	]);

	const selectProjectThread = useEffectEvent(
		(workspacePath: string, nextThreadId: Id<'threadRecords'> | null) => {
			setProjectSelection(workspacePath, nextThreadId, draftWorkspacePath === workspacePath, true);
		}
	);

	useEffect(() => {
		const currentThreads = currentProjectThreads;

		if (!hasResolvedInitialSelection || !currentWorkspacePath) return;

		const nextThreadId = resolveProjectThreadSelection({
			threads: currentThreads,
			currentThreadId,
			currentWorkspacePath,
			draftWorkspacePath
		});

		if (nextThreadId === currentThreadId) return;
		selectProjectThread(currentWorkspacePath, nextThreadId);
	}, [
		currentProjectThreads,
		hasResolvedInitialSelection,
		currentWorkspacePath,
		currentThreadId,
		draftWorkspacePath
	]);

	useEffect(() => {
		let nextPendingAgentLaunches = pendingAgentLaunches;

		if (currentThreadId && runState?.runId) {
			nextPendingAgentLaunches = resolvePendingAgentLaunch(
				nextPendingAgentLaunches,
				currentThreadId,
				runState.runId,
				undefined,
				runState.startedAt
			);
		}

		if (nextPendingAgentLaunches !== pendingAgentLaunches) {
			setPendingAgentLaunches(nextPendingAgentLaunches);
		}
	}, [currentThreadId, runState, pendingAgentLaunches]);

	// Boot sequence: viewport tracking, model catalog, hash/bridge workspace
	// launches, and the local server connection. Runs exactly once per mount.
	const boot = useEffectEvent(() => {
		const bridge = window.sprocketDesktopBridge;

		const unsubscribeWorkspaceLaunch = bridge?.onWorkspaceLaunch
			? bridge.onWorkspaceLaunch(() => {
					void takeDesktopProjectLaunches();
				})
			: undefined;

		const workspacePath = readWorkspaceLaunchFromHash();

		if (workspacePath) {
			queueProjectLaunch(workspacePath);
			clearLaunchHash();
		}

		if (bridge?.takeWorkspaceLaunch) {
			void takeDesktopProjectLaunches().finally(() => setInitialProjectLaunchResolved(true));
		} else {
			setInitialProjectLaunchResolved(true);
		}

		void runtime
			.resolveLocalApi()
			.then(async (client) => {
				setLocalApi(client);
				await reconcileNativeAuthentication();
				setLocalApiResolved(true);
				void refreshDesktopProjectAttachments(client).catch((error) => {
					setCurrentError(
						error instanceof Error ? error.message : 'Failed to load local project attachments.'
					);
				});
			})
			.catch((error) => {
				setCurrentError(
					error instanceof Error ? error.message : 'Failed to connect to the Sprocket server.'
				);
				setLocalApiResolved(true);
			});

		return unsubscribeWorkspaceLaunch;
	});

	useEffect(() => {
		const media = matchMedia('(max-width: 767px)');
		setSidebarOpen(!media.matches);
		setViewportWidth(window.innerWidth);
		const updateViewportWidth = () => setViewportWidth(window.innerWidth);
		window.addEventListener('resize', updateViewportWidth);
		void loadModelCatalog();
		const unsubscribeWorkspaceLaunch = boot();

		return () => {
			unsubscribeWorkspaceLaunch?.();
			window.removeEventListener('resize', updateViewportWidth);
		};
	}, []);

	async function focusSidebarControl(open: boolean) {
		await Promise.resolve();
		document
			.querySelector<HTMLButtonElement>(
				open ? '.inbox-sidebar-host button' : '.inbox-floating-controls button'
			)
			?.focus();
	}

	async function openSidebar() {
		setSidebarOpen(true);
		await focusSidebarControl(true);
	}

	async function closeSidebar() {
		setSidebarOpen(false);
		await focusSidebarControl(false);
	}

	function openSettings(page: SettingsPage = 'general') {
		setSettingsPage(page);
		setSettingsOpen(true);
	}

	async function openSettingsFromFloatingControls() {
		openSettings();

		if (viewportWidth < 768) setSidebarOpen(true);
		await focusSidebarControl(true);
	}

	async function leaveSettings() {
		setSettingsOpen(false);
		setSettingsPage('general');
		await focusSidebarControl(sidebarOpen);
	}

	if (!localApiResolved) {
		return (
			<CalmCentered
				title="Connecting to Sprocket…"
				description="Looking for a running Sprocket server on this machine."
				busy={true}
			/>
		);
	}

	if (!localApi) {
		return (
			<CalmCentered
				title="Connect to Sprocket"
				description={currentError ?? 'Open Sprocket from the desktop app or CLI to continue.'}
			/>
		);
	}

	if (!authReady) {
		return (
			<div className="bg-background h-dvh overflow-hidden">
				<AuthGate
					authState={{
						isLoading:
							!auth.isReady ||
							auth.isLoading ||
							nativeAuthLoading ||
							retryPending ||
							(isSignedIn && convexAuth.isLoading),
						isConfigured: auth.isConfigured,
						isAuthenticated: isSignedIn,
						connectionFailed: authGateBlocked,
						error: auth.error
					}}
					overlayOpen={auth.isWaitingForBrowserSignIn}
					onSignIn={() => void signIn()}
					onSignOut={() => void signOut()}
					onRetry={() => void (nativeSignInRequired ? signIn() : retryConvexAuthentication())}
					retryLabel={nativeSignInRequired ? 'Finish sign-in' : 'Retry'}
					onSignUp={() => void signUp()}
				/>
				<BrowserSignInOverlay
					open={auth.isWaitingForBrowserSignIn}
					signInUrl={auth.browserSignInUrl}
					error={auth.error}
					onCancel={cancelDesktopSignIn}
					onClearOpenError={clearDesktopSignInOpenError}
				/>
			</div>
		);
	}

	return (
		<div className="relative h-dvh overflow-hidden">
			<div
				className={cn(
					'app-workspace-shell inbox-layout',
					!sidebarVisible && 'sidebar-hidden',
					settingsOpen && 'settings-open'
				)}
				style={{
					paddingRight:
						!settingsOpen && artifactPanel.panel.open && !sidePanelFullscreen
							? sidePanelWidth.width
							: undefined
				}}
				inert={
					artifactPanel.fullscreenArtifact ||
					(!settingsOpen && artifactPanel.panel.open && sidePanelFullscreen)
						? true
						: undefined
				}
			>
				{sidebarOpen && (
					<button
						className="inbox-sidebar-backdrop fixed inset-0 z-[140] bg-black/40 md:hidden"
						type="button"
						aria-label="Close sidebar"
						onClick={() => void closeSidebar()}
					/>
				)}
				<div className="inbox-sidebar-host" inert={!sidebarVisible}>
					{settingsOpen ? (
						<SettingsSidebar
							activePage={settingsPage}
							theme={workspaceTheme}
							onThemeChange={(theme) => void handleThemeChange(theme)}
							onBack={() => void leaveSettings()}
							onNavigate={(nextPage) => {
								setSettingsPage(nextPage);

								if (matchMedia('(max-width: 767px)').matches) void closeSidebar();
							}}
						/>
					) : (
						<InboxSidebarContainer
							signedInUserId={signedInUserId}
							pullRequestRefresher={sidebarVisible ? pullRequestRefresher : null}
							repositoryKeys={inboxProjectKeys}
							sections={inbox.sections}
							projects={inboxProjects}
							models={modelCatalog?.models ?? []}
							selectedProjects={projectFilter}
							currentThreadId={currentThreadId}
							settledOpen={settledInboxOpen}
							onSettledOpenChange={setSettledInboxOpen}
							mutationsEnabled={authReady}
							theme={workspaceTheme}
							onThemeChange={(theme) => void handleThemeChange(theme)}
							onClose={() => void closeSidebar()}
							onFilter={(keys) => setProjectFilter(keys)}
							onSelect={selectInboxThread}
							onNew={startThreadDraft}
							onAddProject={() => openProjectPicker('add')}
							onRemoveProject={localApi ? setProjectToRemove : undefined}
							onSettings={() => openSettings()}
							onChange={changeInboxState}
							onRename={(thread, title) => renameThread(thread._id, title)}
							onRegenerateTitle={(thread) => regenerateThreadTitle(thread._id)}
						/>
					)}
				</div>

				{!sidebarVisible && (
					<div className="inbox-floating-controls">
						<BrandMark
							size="sm"
							class="inbox-icon touch-target"
							label="Open sidebar"
							onclick={() => void openSidebar()}
						/>
						<button
							className="inbox-icon touch-target"
							type="button"
							aria-label="Settings"
							title="Settings"
							data-ph-capture-attribute-action="open_settings"
							onClick={() => void openSettingsFromFloatingControls()}
						>
							<Settings size={16} />
						</button>
					</div>
				)}

				<main
					className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
					inert={sidebarOpen && viewportWidth < 768}
				>
					{!settingsOpen && !artifactPanel.panel.open && (
						<button
							type="button"
							className="touch-target text-muted-foreground hover:text-foreground hover:bg-hover-fill focus-visible:ring-ring absolute top-1.5 right-2 z-100 rounded-md p-1.5 transition focus-visible:ring-2 focus-visible:outline-none"
							onClick={() => artifactPanel.update({ open: true })}
							aria-label="Open side panel"
							data-ph-capture-attribute-action="open_side_panel"
						>
							<PanelRight className="size-4" aria-hidden="true" />
						</button>
					)}
					{settingsOpen ? (
						settingsPage === 'general' ? (
							<SettingsGeneral />
						) : settingsPage === 'aiUsage' ? (
							<SettingsAiUsage modelCatalog={modelCatalog} />
						) : settingsPage === 'providers' ? (
							<SettingsProviders
								configuredProviders={configuredProviders}
								onOpenCredentials={() => setSettingsPage('credentials')}
							/>
						) : settingsPage === 'credentials' && signedInUserId ? (
							<SettingsCredentials
								userId={signedInUserId}
								localApi={localApi}
								openAiConfigured={openAiConfigured}
								chatGptStatus={chatGptStatus}
								chatGptLoading={chatGptStatusLoading}
								chatGptStatusError={chatGptStatusError}
								loading={providerConfigurationLoading}
								loadError={providerConfigurationError}
								onChatGptStatusChange={handleChatGptStatusChange}
								onConfigurationChange={handleProviderConfigurationChange}
							/>
						) : settingsPage === 'payments' ? (
							<SettingsPayments />
						) : settingsPage === 'versionControl' && signedInUserId ? (
							<SettingsVersionControl userId={signedInUserId} localApi={localApi} />
						) : (
							<SettingsAccount
								user={auth.user}
								error={auth.error}
								onSignOut={() => void signOut()}
							/>
						)
					) : (
						<MarkdownFileLinksContext value={markdownFileLinks}>
							{currentThreadId && (
								<ThreadTranscript
									key={`${currentThreadId}:${transcript.windowVersion}`}
									messages={visibleMessages}
									actions={visibleActions}
									activeRunId={isRunInProgress ? (runState?.runId ?? null) : null}
									project={currentProject}
									cwd={threadCwd}
									artifacts={artifactPanel.artifacts}
									onOpenArtifact={(artifactId) => artifactPanel.openArtifact(artifactId)}
									loadingOlder={transcript.loadingOlder}
									nextBefore={transcript.nextBefore ?? undefined}
									emptyStateMessage={
										currentThreadId &&
										(transcript.loading || transcript.threadId !== currentThreadId)
											? 'Loading conversation history...'
											: currentProject
												? 'Start a thread and ask Sprocket to inspect code, edit files, or run project commands.'
												: 'Add a project to begin.'
									}
									onLoadOlder={() => void loadOlderTranscript()}
									loadAttachment={loadTranscriptAttachment}
									loadSectionDetails={loadTranscriptSectionDetails}
									renderRunFooter={(runId) => (
										<RunUsageFooter runId={runId} modelCatalog={modelCatalog} />
									)}
								/>
							)}

							<div className={!currentThreadId ? 'create-thread-screen' : 'shrink-0'}>
								{!currentThreadId && (
									<>
										<CreateThreadHeading
											projects={projects}
											workspacePath={currentWorkspacePath}
											onProject={startThreadDraftForProject}
											onAddProject={() => openProjectPicker('add')}
										/>
										{currentProject?.localAttachmentAvailability === 'unavailable' && (
											<p className="create-thread-message">
												Project not connected here.{' '}
												<button
													type="button"
													onClick={() => {
														if (currentWorkspacePath) reconnectProject(currentWorkspacePath);
													}}
												>
													Connect a local folder
												</button>{' '}
												to start local work.
											</p>
										)}
									</>
								)}

								{!catalogError && catalogLoading && !modelCatalog ? (
									<div className="text-muted-foreground mb-3 text-sm">Loading models…</div>
								) : null}

								<div
									ref={setCreateThreadComposerElement}
									className={!currentThreadId ? 'create-thread-composer' : ''}
								>
									<PromptComposer
										notices={({ usageBlocked }) => (
											<ConversationNotices
												key={currentThreadId}
												error={conversationError}
												runError={runError}
												usageBlocked={usageBlocked}
												reconnecting={Boolean(
													currentThreadId &&
													transcript.threadId === currentThreadId &&
													transcript.stale
												)}
												syncing={Boolean(
													currentThreadId &&
													transcript.threadId === currentThreadId &&
													transcript.syncing
												)}
												catalogError={catalogError !== null}
												catalogLoading={catalogLoading}
												onRetryCatalog={() => void loadModelCatalog()}
											/>
										)}
										prompt={prompt}
										onPromptChange={setPrompt}
										attachments={composerAttachments.items}
										onAttachFiles={(files) => composerAttachments.add(files)}
										onRemoveAttachment={(localId) => composerAttachments.remove(localId)}
										modelCatalog={modelCatalog}
										selectedModel={selectedModel}
										onSelectedModelChange={setSelectedModel}
										availableProviders={availableProviders}
										providersReady={providersReady}
										onOpenProviderSettings={() => openSettings('providers')}
										selectedReasoningEffort={selectedReasoningEffort}
										onSelectedReasoningEffortChange={setSelectedReasoningEffort}
										fastMode={fastMode}
										onFastModeChange={setFastMode}
										pendingQuestion={pendingAgentQuestion}
										showContinueWorking={latestRunResumeKind != null}
										onContinueWorking={() => void continueWorking()}
										runningCommands={
											currentThreadId && signedInUserId && localApi && authReady
												? {
														api: localApi,
														scope: { userId: signedInUserId, threadId: currentThreadId }
													}
												: null
										}
										usageThreadId={currentThreadId}
										selectedQuestionOptionId={selectedQuestionOptionId}
										onSelectedQuestionOptionIdChange={setSelectedQuestionOptionId}
										canSend={canSend}
										isSubmitting={
											isSubmittingPrompt || hasPendingAgentLaunch || answeringAgentQuestion
										}
										isStarting={hasPendingAgentLaunch}
										isRunning={!hasPendingAgentLaunch && isStopAvailable}
										isWorking={!hasPendingAgentLaunch && isRunInProgress}
										projectSkills={composerProjectSkills}
										projectPaths={composerProjectPaths}
										onSubmit={() => void submitPrompt()}
										onCancel={() => void cancelRun()}
									/>
								</div>
							</div>
						</MarkdownFileLinksContext>
					)}
				</main>
			</div>

			<MarkdownFileLinksContext value={markdownFileLinks}>
				{!settingsOpen && artifactPanel.panel.open && (
					<div
						className={cn(
							sidePanelFullscreen
								? 'bg-background fixed inset-0 z-50'
								: 'absolute inset-y-0 right-0 z-40',
							phoneViewport && 'motion-safe:animate-side-panel-in'
						)}
						style={{ width: sidePanelFullscreen ? undefined : sidePanelWidth.width }}
						inert={artifactPanel.fullscreenArtifact ? true : undefined}
					>
						{!sidePanelFullscreen && (
							<SidePanelResizeHandle
								width={sidePanelWidth.width}
								minWidth={Math.min(
									sidePanelWidth.maxWidth,
									Math.max(
										sidePanelWidth.minWidth,
										minLayoutSize(artifactPanel.panel.layout, 'row')
									)
								)}
								maxWidth={sidePanelWidth.maxWidth}
								onWidthChange={sidePanelWidth.setWidth}
							/>
						)}
						<SidePanel
							workspacePath={localApi ? currentProject?.workspacePath : undefined}
							threadCwd={threadCwd}
							artifacts={artifactPanel.artifacts}
							onDeleteArtifact={deleteArtifact}
							layout={artifactPanel.panel.layout}
							activePaneId={artifactPanel.activePane.id}
							browserApi={localApi}
							filesApi={localApi}
							expanded={sidePanelFullscreen}
							stale={artifactPanel.watchState.stale}
							error={artifactPanel.watchState.error}
							onNewTab={(paneId) => artifactPanel.newTab(paneId)}
							onActivateTab={(id) => artifactPanel.activateTab(id)}
							onCloseTab={(id) => artifactPanel.closeTab(id)}
							onUpdateTab={(id, patch) => artifactPanel.updateTab(id, patch)}
							onDraftChange={(id, draft) => artifactPanel.setFileDraft(id, draft)}
							onFocusPane={(id) => artifactPanel.focusPane(id)}
							onSplitPane={(id, direction) => artifactPanel.splitPane(id, direction)}
							onResizeSplit={(id, ratio) => artifactPanel.resizeSplit(id, ratio)}
							onOpenFile={(file) => artifactPanel.openFile(file)}
							onFileRenamed={(workspacePath, from, to) =>
								artifactPanel.renameFile(workspacePath, from, to)
							}
							onFileDeleted={(workspacePath, path) => artifactPanel.closeFile(workspacePath, path)}
							onOpenFullscreen={(key) => {
								artifactPanel.setFullscreenKey(key);

								// Request in the click gesture so Firefox keeps true browser
								// fullscreen; the overlay only observes/exits the session.
								if (!document.fullscreenElement) {
									void document.documentElement.requestFullscreen?.().catch(() => {});
								}
							}}
							onToggleExpanded={
								phoneViewport
									? undefined
									: () => artifactPanel.update({ expanded: !artifactPanel.panel.expanded })
							}
							onClose={() => artifactPanel.update({ open: false, expanded: false })}
						/>
					</div>
				)}

				{artifactPanel.fullscreenArtifact && (
					<ArtifactScreenFullscreen
						workspacePath={localApi ? currentProject?.workspacePath : undefined}
						artifact={artifactPanel.fullscreenArtifact}
						onClose={() => artifactPanel.setFullscreenKey(null)}
					/>
				)}
			</MarkdownFileLinksContext>

			{localApi && projectPickerOpen && (
				<ProjectPicker
					open={projectPickerOpen}
					localApi={localApi}
					mode={projectPickerMode}
					expectedDisplayName={projectPickerExpectedDisplayName}
					recentProjectPaths={recentProjectDirectories}
					onRemoveProject={setProjectToRemove}
					onClose={() => {
						setProjectPickerOpen(false);
						setProjectPickerReconnectWorkspacePath(null);
						setProjectPickerExpectedDisplayName(undefined);
					}}
					onSelect={async (selection) => {
						try {
							await handleProjectSelected(selection);
						} catch {
							await refreshDesktopProjectAttachments();
						}
					}}
				/>
			)}
			{projectToRemove && (
				<RemoveProjectDialog
					project={projectToRemove}
					onClose={() => setProjectToRemove(null)}
					onPrepareRemove={prepareProjectRemoval}
					onRemove={removeProject}
				/>
			)}
		</div>
	);
}
