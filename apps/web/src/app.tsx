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
import CreateThreadHeading from '$lib/components/home/create-thread-heading';
import '$lib/components/home/create-thread.css';
import '$lib/components/home/inbox.css';
import BrandMark from '$lib/components/brand-mark';
import InboxSidebar, { type SidebarChildrenResolver } from '$lib/components/home/inbox-sidebar';
import InboxLoadMore from '$lib/components/home/inbox-load-more';
import SettingsAccount from '$lib/components/home/settings-account';
import SettingsPayments from '$lib/components/home/settings-payments';
import SettingsProviders from '$lib/components/home/settings-providers';
import SettingsSidebar, { type SettingsPage } from '$lib/components/home/settings-sidebar';
import SettingsUsage from '$lib/components/home/settings-usage';
import ThreadTranscript from '$lib/components/home/thread-transcript';
import SidePanel from '$lib/components/home/side-panel';
import ArtifactScreenFullscreen from '$lib/components/home/artifact-screen-fullscreen';
import { createConvexArtifactClient, useArtifactPanel } from '$lib/home/artifact-panel';
import ProjectPicker, { type ProjectSelection } from '$lib/components/home/project-picker';
import Button from '$lib/components/ui/button/button';
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
import { useComposerAttachments } from '$lib/home/composer-attachments';
import { defaultModelId, defaultReasoningEffort } from '@convex/lib/models';
import type { CompletionProvider } from '@convex/lib/validators';
import {
	CATALOG_UNAVAILABLE_MESSAGE,
	fetchGatewayModelCatalog,
	type CatalogModelId,
	type ModelCatalog
} from '$lib/chat/model-catalog';
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
	useExpandedThreads,
	useRevealPaginatedThread,
	useSelectedThreadAncestryReveal,
	useThreadChildren,
	type UseExpandedThreads
} from '$lib/project/useThreadTree';
import type { InboxState } from '@convex/lib/inboxState';
import { useTranscriptReplica } from '$lib/home/transcript-replica';
import type { TranscriptDisplayRow, TranscriptDetailCursor } from '$lib/types/sprocket';
import { clearLaunchHash, readWorkspaceLaunchFromHash, resolveDesktopApi } from '$lib/local/client';
import { applyTheme, resolveTheme, type SprocketTheme } from '$lib/theme';
import type {
	ChatGptStatus,
	DesktopApi,
	ExecutorJob,
	ThreadSummary,
	ProjectAttachment
} from '$lib/types/sprocket';
import { cn } from '$lib/utils';

type ConvexQuery = FunctionReference<'query'>;

// Query failures belong in the page's inline error UI, not the startup boundary.
function usePageQuery<Query extends ConvexQuery>(query: Query, args: FunctionArgs<Query> | 'skip') {
	const result = useConvexQueryResult({ query, args });

	if (result.status === 'error') return { data: undefined, error: result.error };

	if (result.status === 'pending') return { data: undefined, error: null };

	return { data: result.data, error: null };
}

const localServerRequiredMessage = 'Connect to a running Sprocket server to use this project.';

const agentLaunchTimeoutMs = 30_000;

type SidebarProps = ComponentProps<typeof InboxSidebar>;

function InboxSidebarContainer(
	props: Omit<SidebarProps, 'expansion' | 'resolveChildren'> & {
		signedInUserId: string | null;
		repositoryKeys: string[];
	}
) {
	const expansion = useExpandedThreads(props.signedInUserId);
	const { currentThreadId, onSettledOpenChange } = props;

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

	const root = useRevealInboxThread(
		rootQuery.status === 'success' ? rootQuery.data : null,
		props.repositoryKeys,
		props.sections
	);

	const revealedSettledRef = useRef<Id<'threadRecords'> | null>(null);

	useEffect(() => {
		if (!root || root.archivedAt === undefined) {
			revealedSettledRef.current = null;

			return;
		}

		if (revealedSettledRef.current === currentThreadId) return;
		revealedSettledRef.current = currentThreadId;
		onSettledOpenChange(true);
	}, [root, currentThreadId, onSettledOpenChange]);

	const resolveChildren: SidebarChildrenResolver = useCallback(
		({ threadId, renderRows }) => (
			<ExpandedThreadChildren
				expansion={expansion}
				threadId={threadId}
				renderRows={renderRows}
				selectedPath={selectedPath}
			/>
		),
		[expansion, selectedPath]
	);

	return <InboxSidebar {...props} expansion={expansion} resolveChildren={resolveChildren} />;
}

function ExpandedThreadChildren({
	expansion,
	threadId,
	renderRows,
	selectedPath
}: Parameters<SidebarChildrenResolver>[0] & {
	expansion: UseExpandedThreads;
	selectedPath: readonly Id<'threadRecords'>[];
}) {
	const children = useThreadChildren(threadId);
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
	resolveDesktopApi: () => Promise<DesktopApi>;
	fetchGatewayModelCatalog: (origin: string) => Promise<ModelCatalog>;
};

const productionAppRuntime: AppRuntime = { resolveDesktopApi, fetchGatewayModelCatalog };

function getComposerScope(threadId: Id<'threadRecords'> | null, workspacePath: string | null) {
	return threadId ? `thread:${threadId}` : workspacePath ? `draft:${workspacePath}` : null;
}

function getComposerRecoveryKey(userId: string, scope: string) {
	return `${userId}\0${scope}`;
}

type ComposerRecovery = {
	message: string;
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
	const settleThreadRecord = useMutation(api.threads.settle);
	const unsettleThreadRecord = useMutation(api.threads.unsettle);
	const answerAgentQuestion = useMutation(api.agentQuestions.answer);
	const setThemePreference = useMutation(api.uiPreferences.setTheme);
	const ensureMySubscription = useMutation(api.billing.ensureMySubscription);

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

	const [desktopApi, setDesktopApi] = useState<DesktopApi | null>(null);
	const desktopApiRef = useRef(desktopApi);
	const [desktopApiResolved, setDesktopApiResolved] = useState(false);

	const chatGptStatusLoadedFor = useRef<{ userId: string; api: DesktopApi } | null>(null);
	const chatGptStatusGeneration = useRef(0);

	const chatGptStatusChangeEvent = useEffectEvent((status: ChatGptStatus) => {
		handleChatGptStatusChange(status);
	});

	useEffect(() => {
		const userId = signedInUserId;

		if (!authReady || !userId || !desktopApi) {
			chatGptStatusLoadedFor.current = null;
			setChatGptStatus(null);
			setChatGptConfigured(false);
			setChatGptStatusLoading(false);

			return;
		}

		if (
			chatGptStatusLoadedFor.current?.userId === userId &&
			chatGptStatusLoadedFor.current.api === desktopApi
		)
			return;
		chatGptStatusLoadedFor.current = { userId, api: desktopApi };
		const generation = ++chatGptStatusGeneration.current;
		setChatGptStatus(null);
		setChatGptConfigured(false);
		setChatGptStatusLoading(true);
		setChatGptStatusError(null);
		desktopApi
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
	}, [authReady, signedInUserId, desktopApi]);

	const [currentWorkspacePath, setCurrentWorkspacePath] = useState<string | null>(null);
	const [currentRepositoryKey, setCurrentRepositoryKey] = useState<string | null>(null);
	const [currentThreadId, setCurrentThreadId] = useState<Id<'threadRecords'> | null>(null);
	const [draftWorkspacePath, setDraftWorkspacePath] = useState<string | null>(null);
	// Seed from compiled defaults; composer effects adopt live catalog defaults once loaded.
	const [selectedModel, setSelectedModel] = useState<CatalogModelId>(defaultModelId);

	const [selectedCompletionProvider, setSelectedCompletionProvider] =
		useState<CompletionProvider>('spikonado');

	const [selectedReasoningEffort, setSelectedReasoningEffort] =
		useState<string>(defaultReasoningEffort);

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
	const [projectPickerMode, setProjectPickerMode] = useState<'add' | 'reconnect'>('add');

	const [projectPickerExpectedDisplayName, setProjectPickerExpectedDisplayName] = useState<
		string | undefined
	>(undefined);

	const [projectPickerReconnectWorkspacePath, setProjectPickerReconnectWorkspacePath] = useState<
		string | null
	>(null);

	const [settingsOpen, setSettingsOpen] = useState(false);
	const [settingsPage, setSettingsPage] = useState<SettingsPage>('account');
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const [viewportWidth, setViewportWidth] = useState(0);
	const sidebarVisible = sidebarOpen || (settingsOpen && viewportWidth >= 768);
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
			api: desktopApi,
			userId: signedInUserId,
			threadId: currentThreadId
		},
		onError: setCurrentError,
		localServerRequiredMessage
	});

	const transcript = useTranscriptReplica();
	const artifactPanel = useArtifactPanel();
	const artifactClient = useMemo(() => createConvexArtifactClient(convexClient), [convexClient]);

	// Queries stay skipped until Convex confirms the token; running them on the
	// account id alone surfaces a spurious auth error during sign-in.
	const authenticatedQueryArgs =
		signedInUserId && convexAuth.isAuthenticated && !convexAuth.isLoading ? {} : 'skip';

	const uiPreferencesQuery = usePageQuery(api.uiPreferences.getMine, authenticatedQueryArgs);

	const authenticatedThreadQueryArgs =
		currentThreadId && authenticatedQueryArgs !== 'skip' ? { threadId: currentThreadId } : 'skip';

	const activeThreadQuery = usePageQuery(api.threads.getByThreadId, authenticatedThreadQueryArgs);

	const lifecycleQuery = usePageQuery(
		api.chat.selectedThreadLifecycle,
		authenticatedThreadQueryArgs
	);

	// No browser backend is wired up; the live view stays empty until the local
	// browser implementation provides session state.
	const browserLiveView = { data: null, error: null };

	const pendingAgentQuestionQuery = usePageQuery(
		api.agentQuestions.headPendingForThread,
		authenticatedThreadQueryArgs
	);

	const queryError =
		uiPreferencesQuery.error ??
		activeThreadQuery.error ??
		lifecycleQuery.error ??
		pendingAgentQuestionQuery.error;

	const createThreadError =
		currentError ?? auth.error ?? (queryError ? convexClientErrorMessage(queryError) : null);

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

	const inboxProjectKeys = useMemo(
		() =>
			projectFilter.length > 0
				? projectFilter
				: inboxProjects.map((project) => project.repositoryKey),
		[projectFilter, inboxProjects]
	);

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
	const runState = currentLifecycle?.run ?? null;
	const pendingAgentQuestion = dataForThread(pendingAgentQuestionQuery.data, currentThreadId);

	useEffect(() => {
		const threadId = currentThreadId;

		if (transcript.threadId !== threadId) transcript.selectThread(threadId);
	}, [currentThreadId, transcript]);

	useEffect(() => {
		const threadId = currentThreadId;
		const api = desktopApi;

		if (!threadId || !api || !isSignedIn) return;
		const userId = signedInUserIdRef.current;

		if (!userId) return;

		return transcript.watchDisplay({
			api,
			userId,
			threadId,
			isCurrent: () => currentThreadIdRef.current === threadId
		});
	}, [currentThreadId, desktopApi, isSignedIn, transcript, signedInUserId]);

	useEffect(() => {
		const threadId = currentThreadId;
		const api = desktopApi;

		if (!threadId || !api || !isSignedIn) return;
		const userId = signedInUserIdRef.current;

		if (!userId) return;

		return transcript.watchLiveCompletion({
			api,
			userId,
			threadId,
			isCurrent: () => currentThreadIdRef.current === threadId
		});
	}, [currentThreadId, desktopApi, isSignedIn, transcript, signedInUserId]);

	const currentThreadIdRef = useRef(currentThreadId);
	const currentWorkspacePathRef = useRef(currentWorkspacePath);
	const currentRepositoryKeyRef = useRef(currentRepositoryKey);
	const draftWorkspacePathRef = useRef(draftWorkspacePath);

	useEffect(() => {
		transcript.syncOverlays(transcript.overlays);
	});

	const visibleMessages = transcript.visibleMessages({
		threadId: currentThreadId,
		userId: signedInUserId,
		run: runState
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
		if (!currentProjectPath || !desktopApi) return null;

		return {
			workspacePath: currentProjectPath,
			search: (query: string, signal: AbortSignal) =>
				desktopApi.searchWorkspace({ workspacePath: currentProjectPath, query }, signal)
		};
	}, [currentProjectPath, desktopApi]);

	const composerProjectSkills = useMemo(() => {
		const workspacePath = currentProject?.workspacePath ?? null;
		const api = desktopApi;

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
	}, [currentProject, desktopApi]);

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
			localApi: desktopApi,
			artifactClient,
			cloudReady: !convexAuth.isLoading && convexAuth.isAuthenticated,
			scope
		});
	}, [
		artifactPanel,
		signedInUserId,
		currentRepositoryKey,
		currentWorkspacePath,
		desktopApi,
		artifactClient,
		convexAuth.isLoading,
		convexAuth.isAuthenticated
	]);

	const deleteArtifact =
		currentRepositoryKey && convexAuth.isAuthenticated && !convexAuth.isLoading
			? async (artifactId: string) => {
					if (desktopApi && signedInUserId && currentWorkspacePath) {
						await desktopApi.deleteArtifact({
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
			: lifecycleResumeKind(currentLifecycle?.phase ?? 'idle', currentLifecycle?.run?.lastError);

	const isLatestRunReady = isLatestRunReadyForThread({
		threadId: currentThreadId,
		pendingCreatedThreadId,
		hasLatestRunData: Boolean(currentLifecycle)
	});

	const isSubmittingPrompt = Boolean(
		currentComposerScope && submittingPromptScopes.has(currentComposerScope)
	);

	const canSend = Boolean(
		currentProjectPath &&
		(pendingAgentQuestion || selectedCompletionProvider !== 'chatgpt' || chatGptConfigured) &&
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
		client = desktopApiRef.current
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
		const api = desktopApi;
		const userId = signedInUserIdRef.current;

		if (api && userId) {
			await api.endAccountSession({ userId }).catch(() => {});
		}

		await authSignOut();
	}

	const registerAccountSession = useEffectEvent((api: DesktopApi, userId: string) => {
		void api.startAccountSession({ userId }).catch((error) => {
			if (desktopApiRef.current === api && signedInUserIdRef.current === userId) {
				setCurrentError(
					error instanceof Error ? error.message : 'Failed to register this Sprocket process.'
				);
			}
		});
	});

	useEffect(() => {
		if (!desktopApi || !signedInUserId || !authReady) return;
		registerAccountSession(desktopApi, signedInUserId);
	}, [desktopApi, signedInUserId, authReady]);

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
		client = desktopApiRef.current
	) {
		if (!client) {
			throw new Error(localServerRequiredMessage);
		}

		const attachment = await attachLocalProjectForPath({
			desktopApi: client,
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
		if (!desktopApi) {
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
		if (!desktopApi) {
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
		client?: DesktopApi
	) {
		await attachLocalProject(selection.workspacePath, undefined, client);

		if (signedInUserIdRef.current !== expectedUserId) return;
		setProjectSelection(selection.workspacePath, null, true, false, selection.repositoryKey);
		setCurrentError(null);
	}

	async function reconnectProjectSelection(
		selection: ProjectSelection,
		previousWorkspacePath: string,
		expectedUserId: string,
		client?: DesktopApi
	) {
		const previousProject = findProjectByWorkspacePath(projects, previousWorkspacePath);
		await attachLocalProject(
			selection.workspacePath,
			previousWorkspacePath === selection.workspacePath ? undefined : previousWorkspacePath,
			client
		);

		if (signedInUserIdRef.current !== expectedUserId) return;

		const keepThread =
			previousProject?.repositoryKey === selection.repositoryKey
				? currentThreadIdRef.current
				: null;

		setProjectSelection(selection.workspacePath, keepThread, false, false, selection.repositoryKey);
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

	async function openLaunchedProject(workspacePath: string, client: DesktopApi, userId: string) {
		const selection = await client.resolveWorkspacePath({ workspacePath });

		if (signedInUserIdRef.current !== userId) return;
		await addProjectSelection(selection, userId, client);
	}

	async function verifyProject(workspacePath: string) {
		await verifyProjectAttachmentForExecution({
			desktopApi,
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

		if (!change.configured && selectedCompletionProvider === change.provider) {
			setSelectedCompletionProvider('spikonado');
		}
	}

	function handleChatGptStatusChange(status: ChatGptStatus) {
		chatGptStatusGeneration.current += 1;
		setChatGptStatusLoading(false);
		setChatGptStatus(status);
		setChatGptStatusError(status.error ?? null);

		const active = status.accounts.find(
			(account) => account.connectionId === status.activeConnectionId
		);

		const configured = active?.connected === true;
		setChatGptConfigured(configured);

		if (!configured && selectedCompletionProvider === 'chatgpt') {
			setSelectedCompletionProvider('spikonado');
		}
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

	async function loadOlderTranscript() {
		await transcript.loadOlder();
	}

	async function loadTranscriptAttachment(storageId: Id<'_storage'>) {
		const api = desktopApi;
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
		const api = desktopApi;
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
		const submittedCompletionProvider = selectedCompletionProvider;
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

		if (!desktopApi) {
			setCurrentError(localServerRequiredMessage);

			return;
		}

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
		const submittedCompletionProvider = selectedCompletionProvider;
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

		const recoverSubmission = (message: string) => {
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
					!selectedThreadId && recoveryScope === originatingRecoveryScope
						? threadSubmissionId
						: runSubmissionId
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
				const resolution = await desktopApi.resolveWorkspacePath({ workspacePath });

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

			await launchAgentRun({
				userId: submittedUserId,
				desktopApi,
				onError: (error) => {
					if (!isSubmissionCurrent() || !isSubmittedUserCurrent()) return;

					if (threadId) {
						const nextPendingAgentLaunches = clearPendingAgentLaunch(
							pendingAgentLaunchesRef.current,
							threadId,
							launchId
						);

						if (nextPendingAgentLaunches !== pendingAgentLaunchesRef.current) {
							setPendingAgentLaunches(nextPendingAgentLaunches);
						}
					}

					recoverSubmission(
						error instanceof Error ? error.message : 'Failed to start the local agent run.'
					);
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
		desktopApiRef.current = desktopApi;
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
		desktopApi,
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
			setCurrentError(error instanceof Error ? error.message : 'Failed to cancel run.');
		}
	}

	async function continueWorking() {
		if (
			!latestRunResumeKind ||
			!runState ||
			!currentThreadId ||
			!currentProjectPath ||
			hasPendingAgentLaunch ||
			isSubmittingPrompt
		) {
			return;
		}

		if (!desktopApi) {
			setCurrentError(localServerRequiredMessage);

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
				desktopApi,
				onError: (error) => {
					setPendingAgentLaunches((launches) =>
						clearPendingAgentLaunch(launches, threadId, launchId)
					);

					if (signedInUserIdRef.current !== userId || currentThreadIdRef.current !== threadId)
						return;
					setCurrentError(error.message);
				},
				onStarted: () => {},
				threadId,
				prompt: '',
				storageIds: [],
				selectedModel,
				completionProvider: selectedCompletionProvider,
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
		setSelectedModel(modelCatalog?.defaultModelId ?? defaultModelId);
		setSelectedCompletionProvider('spikonado');
		setSelectedReasoningEffort(modelCatalog?.defaultReasoningEffort ?? defaultReasoningEffort);
		setFastMode(false);
		setProjectPickerOpen(false);
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
		(workspacePath: string, client: DesktopApi, userId: string) => {
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
			!desktopApi ||
			!signedInUserId ||
			!hasLoadedDesktopProjectAttachments
		) {
			return;
		}

		startPendingProjectLaunch(workspacePath, desktopApi, signedInUserId);
	}, [
		pendingProjectLaunches,
		projectLaunchInFlight,
		desktopApi,
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
		setSelectedCompletionProvider(thread.completionProvider ?? 'spikonado');
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
			!desktopApi ||
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
		desktopApi,
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
			.resolveDesktopApi()
			.then(async (client) => {
				setDesktopApi(client);
				await reconcileNativeAuthentication();
				setDesktopApiResolved(true);
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
				setDesktopApiResolved(true);
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

	function openSettings() {
		setSettingsPage('account');
		setSettingsOpen(true);
	}

	async function openSettingsFromFloatingControls() {
		openSettings();

		if (viewportWidth < 768) setSidebarOpen(true);
		await focusSidebarControl(true);
	}

	async function leaveSettings() {
		setSettingsOpen(false);
		setSettingsPage('account');
		await focusSidebarControl(sidebarOpen);
	}

	if (!desktopApiResolved) {
		return (
			<CalmCentered
				title="Connecting to Sprocket…"
				description="Looking for a running Sprocket server on this machine."
				busy={true}
			/>
		);
	}

	if (!desktopApi) {
		return (
			<CalmCentered
				title="Connect to Sprocket"
				description={currentError ?? 'Open Sprocket from the desktop app or CLI to continue.'}
			/>
		);
	}

	if (!authReady) {
		return (
			<div className="bg-background h-screen overflow-hidden">
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
		<div className="relative h-screen overflow-hidden">
			<div
				className={cn(
					'app-workspace-shell inbox-layout',
					!settingsOpen && artifactPanel.panel.open && !artifactPanel.panel.expanded
						? 'pr-[20rem]'
						: '',
					!sidebarVisible && 'sidebar-hidden',
					settingsOpen && 'settings-open'
				)}
				inert={
					artifactPanel.fullscreenArtifact ||
					(artifactPanel.panel.open && artifactPanel.panel.expanded)
						? true
						: undefined
				}
			>
				{sidebarOpen && (
					<button
						className="fixed inset-0 z-[140] bg-black/40 md:hidden"
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
							onSettings={openSettings}
							onChange={changeInboxState}
							onRename={(thread, title) => renameThread(thread._id, title)}
						/>
					)}
				</div>

				{!sidebarVisible && (
					<div className="inbox-floating-controls">
						<BrandMark
							size="sm"
							class="inbox-icon"
							label="Open sidebar"
							onclick={() => void openSidebar()}
						/>
						<button
							className="inbox-icon"
							type="button"
							aria-label="Settings"
							title="Settings"
							onClick={() => void openSettingsFromFloatingControls()}
						>
							<Settings size={16} />
						</button>
					</div>
				)}

				<main
					className="relative flex h-screen min-h-0 min-w-0 flex-col overflow-hidden"
					inert={sidebarOpen && viewportWidth < 768}
				>
					{!settingsOpen && !artifactPanel.panel.open && (
						<button
							type="button"
							className="text-muted-foreground hover:text-foreground hover:bg-muted absolute top-3 right-3 z-100 inline-flex items-center justify-center rounded-md p-2 transition"
							onClick={() => artifactPanel.update({ open: true })}
							aria-label="Open side panel"
						>
							<PanelRight className="size-4" aria-hidden="true" />
						</button>
					)}
					{settingsOpen ? (
						settingsPage === 'usage' ? (
							<SettingsUsage />
						) : settingsPage === 'providers' && signedInUserId ? (
							<SettingsProviders
								userId={signedInUserId}
								desktopApi={desktopApi}
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
						) : (
							<SettingsAccount user={auth.user} onSignOut={() => void signOut()} />
						)
					) : (
						<>
							{currentThreadId && (
								<ThreadTranscript
									key={`${currentThreadId}:${transcript.windowVersion}`}
									userId={signedInUserId ?? undefined}
									currentError={
										transcript.error ??
										currentError ??
										auth.error ??
										(queryError ? convexClientErrorMessage(queryError) : null) ??
										null
									}
									runError={latestRunResumeKind ? null : (runState?.lastError ?? null)}
									messages={visibleMessages}
									actions={visibleActions}
									activeRunId={isRunInProgress ? (runState?.runId ?? null) : null}
									project={currentProject}
									artifacts={artifactPanel.artifacts}
									onOpenArtifact={(artifactId) => {
										artifactPanel.update({
											open: true,
											tab: 'artifacts',
											selectedKey: artifactId
										});
									}}
									stale={transcript.stale}
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
								/>
							)}

							<div className={!currentThreadId ? 'create-thread-screen' : ''}>
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
										{createThreadError && (
											<p className="create-thread-message text-destructive" role="alert">
												{createThreadError}
											</p>
										)}
									</>
								)}

								{catalogError ? (
									<div
										role="alert"
										className="text-destructive mb-3 flex items-center justify-between gap-3 rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm"
									>
										<span>{CATALOG_UNAVAILABLE_MESSAGE}</span>
										<Button
											variant="outline"
											className="h-8 px-3"
											disabled={catalogLoading}
											onclick={() => void loadModelCatalog()}
										>
											{catalogLoading ? 'Retrying…' : 'Retry'}
										</Button>
									</div>
								) : catalogLoading && !modelCatalog ? (
									<div className="text-muted-foreground mb-3 text-sm">Loading models…</div>
								) : null}

								<div
									ref={setCreateThreadComposerElement}
									className={!currentThreadId ? 'create-thread-composer' : ''}
								>
									<PromptComposer
										prompt={prompt}
										onPromptChange={setPrompt}
										attachments={composerAttachments.items}
										onAttachFiles={(files) => composerAttachments.add(files)}
										onRemoveAttachment={(localId) => composerAttachments.remove(localId)}
										modelCatalog={modelCatalog}
										selectedModel={selectedModel}
										onSelectedModelChange={setSelectedModel}
										configuredProviders={configuredProviders}
										providersReady={providerConfigurationReady}
										selectedCompletionProvider={selectedCompletionProvider}
										onSelectedCompletionProviderChange={setSelectedCompletionProvider}
										selectedReasoningEffort={selectedReasoningEffort}
										onSelectedReasoningEffortChange={setSelectedReasoningEffort}
										fastMode={fastMode}
										onFastModeChange={setFastMode}
										pendingQuestion={pendingAgentQuestion}
										showContinueWorking={latestRunResumeKind != null}
										onContinueWorking={() => void continueWorking()}
										runningCommands={
											currentThreadId && signedInUserId && desktopApi && authReady
												? {
														api: desktopApi,
														scope: { userId: signedInUserId, threadId: currentThreadId }
													}
												: null
										}
										selectedQuestionOptionId={selectedQuestionOptionId}
										onSelectedQuestionOptionIdChange={setSelectedQuestionOptionId}
										canSend={canSend}
										isSubmitting={
											isSubmittingPrompt || hasPendingAgentLaunch || answeringAgentQuestion
										}
										isStarting={hasPendingAgentLaunch}
										isRunning={!hasPendingAgentLaunch && isStopAvailable}
										runStartedAt={isRunInProgress ? (runState?.startedAt ?? null) : null}
										projectSkills={composerProjectSkills}
										projectPaths={composerProjectPaths}
										onSubmit={() => void submitPrompt()}
										onCancel={() => void cancelRun()}
									/>
								</div>
							</div>
						</>
					)}
				</main>
			</div>

			{!settingsOpen && artifactPanel.panel.open && (
				<div
					className={
						artifactPanel.panel.expanded
							? 'bg-background fixed inset-0 z-50'
							: 'absolute inset-y-0 right-0 z-40 w-[20rem]'
					}
					inert={artifactPanel.fullscreenArtifact ? true : undefined}
				>
					<SidePanel
						workspacePath={desktopApi ? currentProject?.workspacePath : undefined}
						artifacts={artifactPanel.artifacts}
						onDeleteArtifact={deleteArtifact}
						selectedKey={artifactPanel.panel.selectedKey}
						tab={artifactPanel.panel.tab}
						liveView={browserLiveView.data}
						liveActive={false}
						expanded={artifactPanel.panel.expanded}
						stale={artifactPanel.watchState.stale}
						error={artifactPanel.watchState.error}
						onSelect={(key) => artifactPanel.update({ selectedKey: key })}
						onBack={() => artifactPanel.update({ selectedKey: null })}
						onTabChange={(tab) => artifactPanel.update({ tab })}
						onOpenFullscreen={(key) => {
							artifactPanel.setFullscreenKey(key);

							// Request in the click gesture so Firefox keeps true browser
							// fullscreen; the overlay only observes/exits the session.
							if (!document.fullscreenElement) {
								void document.documentElement.requestFullscreen?.().catch(() => {});
							}
						}}
						onToggleExpanded={() =>
							artifactPanel.update({ expanded: !artifactPanel.panel.expanded })
						}
						onClose={() => artifactPanel.update({ open: false, expanded: false })}
					/>
				</div>
			)}

			{artifactPanel.fullscreenArtifact && (
				<ArtifactScreenFullscreen
					workspacePath={desktopApi ? currentProject?.workspacePath : undefined}
					artifact={artifactPanel.fullscreenArtifact}
					onClose={() => artifactPanel.setFullscreenKey(null)}
				/>
			)}

			{desktopApi && projectPickerOpen && (
				<ProjectPicker
					open={projectPickerOpen}
					desktopApi={desktopApi}
					mode={projectPickerMode}
					expectedDisplayName={projectPickerExpectedDisplayName}
					recentProjectPaths={recentProjectDirectories}
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
		</div>
	);
}
