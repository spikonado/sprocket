<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { elapsedSeconds, tickingNow } from '$lib/chat/elapsed-time';
	import { page } from '$app/state';
	import { PanelLeft, PanelRight } from '@lucide/svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { useAuth, useConvexClient, useMutation, useQuery } from 'convex-svelte';
	import type { Doc, Id } from '$convex/_generated/dataModel';
	import { api } from '$convex/_generated/api';
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
	import AuthGate from '$lib/components/home/auth-gate.svelte';
	import BrowserSignInOverlay from '$lib/components/home/browser-signin-overlay.svelte';
	import CalmCentered from '$lib/components/home/calm-centered.svelte';
	import PromptComposer from '$lib/components/home/prompt-composer.svelte';
	import CreateThreadHeading from '$lib/components/home/create-thread-heading.svelte';
	import '$lib/components/home/create-thread.css';
	import '$lib/components/home/inbox.css';
	import InboxSidebar from '$lib/components/home/inbox-sidebar.svelte';
	import SettingsAccount from '$lib/components/home/settings-account.svelte';
	import SettingsBrowser from '$lib/components/home/settings-browser.svelte';
	import SettingsPayments from '$lib/components/home/settings-payments.svelte';
	import SettingsSidebar, { type SettingsPage } from '$lib/components/home/settings-sidebar.svelte';
	import SettingsUsage from '$lib/components/home/settings-usage.svelte';
	import ThreadTranscript from '$lib/components/home/thread-transcript.svelte';
	import SidePanel from '$lib/components/home/side-panel.svelte';
	import ArtifactScreenFullscreen from '$lib/components/home/artifact-screen-fullscreen.svelte';
	import { ArtifactPanel } from '$lib/home/artifact-panel.svelte';
	import ProjectPicker, { type ProjectSelection } from '$lib/components/home/project-picker.svelte';
	import Button from '$lib/components/ui/button/button.svelte';
	import {
		attachLocalProject as attachLocalProjectForPath,
		launchAgentRun,
		lifecycleResumeKind,
		refreshDesktopProjectAttachments as refreshDesktopProjectAttachmentsFromDesktop,
		projectFromAttachment,
		resolveSubmissionId,
		upsertDesktopProjectAttachment,
		verifyProjectAttachment as verifyProjectAttachmentForExecution,
		type ProjectState
	} from '$lib/home/desktop';
	import { formatElapsedDuration } from '$lib/format';
	import { convexClientErrorMessage } from '$lib/convex-error';
	import type { ComposerAttachment } from '$lib/chat/attachments';
	import { ComposerAttachments } from '$lib/home/composer-attachments.svelte';
	import { defaultModelId, defaultReasoningEffort } from '$convex/lib/models';
	import {
		CATALOG_UNAVAILABLE_MESSAGE,
		fetchGatewayModelCatalog,
		type CatalogModelId,
		type ModelCatalog
	} from '$lib/chat/model-catalog';
	import { isLifecycleInProgress } from '$convex/lib/runCancellation';
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
		resolveExpiredAgentLaunch,
		resolveInitialDraftSelection,
		resolvePendingAgentLaunch,
		resolvePendingCreatedThreadId,
		resolveProjectThreadSelection,
		threadRecordToSummary,
		type PendingAgentLaunch,
		type PendingAgentLaunches
	} from '$lib/project/threads';
	import { useThreadInbox } from '$lib/project/inbox.svelte';
	import type { InboxState } from '$convex/lib/inboxState';
	import { TranscriptReplica } from '$lib/home/transcript-replica.svelte';
	import type { TranscriptDisplayRow, TranscriptDetailCursor } from '$lib/types/sprocket';
	import {
		clearLaunchHash,
		readWorkspaceLaunchFromHash,
		resolveDesktopApi
	} from '$lib/local/client';
	import { applyTheme, resolveTheme, type SprocketTheme } from '$lib/theme';
	import type {
		DesktopApi,
		ExecutorJob,
		ThreadSummary,
		ProjectAttachment
	} from '$lib/types/sprocket';

	const convexAuth = useAuth();
	const artifactClient = useConvexClient();
	let sawAuthLoadingDuringRetry = $state(false);
	const signedInUserId = $derived($convexAuthUserId);
	const isSignedIn = $derived(Boolean(signedInUserId));
	const retryPending = $derived($convexAuthRetryPending);
	const nativeAuthLoading = $derived($authState.nativeSession === 'loading');
	const nativeAuthBlocked = $derived(
		$authState.nativeSession === 'missing' ||
			$authState.nativeSession === 'mismatch' ||
			$authState.nativeSession === 'unavailable'
	);
	const nativeSignInRequired = $derived(
		$authState.nativeSession === 'missing' || $authState.nativeSession === 'mismatch'
	);
	const authReady = $derived(
		$authState.isReady &&
			!$authState.isLoading &&
			isSignedIn &&
			($authState.nativeSession === 'notRequired' || $authState.nativeSession === 'ready') &&
			!convexAuth.isLoading &&
			convexAuth.isAuthenticated
	);
	const authConnectionFailed = $derived(
		isSignedIn &&
			$authState.isReady &&
			!$authState.isLoading &&
			!retryPending &&
			!convexAuth.isLoading &&
			!convexAuth.isAuthenticated
	);
	const authGateBlocked = $derived(authConnectionFailed || nativeAuthBlocked);

	$effect(() => {
		const next = advanceConvexAuthRetryPending({
			retryPending,
			isAuthenticated: convexAuth.isAuthenticated,
			isLoading: convexAuth.isLoading,
			sawLoadingDuringRetry: sawAuthLoadingDuringRetry
		});
		if (sawAuthLoadingDuringRetry !== next.sawLoadingDuringRetry) {
			sawAuthLoadingDuringRetry = next.sawLoadingDuringRetry;
		}
		if (next.clearPending) {
			convexAuthRetryPending.set(false);
		}
	});
	const setThreadSelectedModel = useMutation(api.threads.setSelectedModel);
	const renameThreadRecord = useMutation(api.threads.rename);
	const settleThreadRecord = useMutation(api.threads.settle);
	const unsettleThreadRecord = useMutation(api.threads.unsettle);
	const answerAgentQuestion = useMutation(api.agentQuestions.answer);
	const setThemePreference = useMutation(api.uiPreferences.setTheme);
	const ensureMySubscription = useMutation(api.billing.ensureMySubscription);
	let modelCatalog = $state<ModelCatalog | undefined>(undefined);
	let catalogError = $state<string | null>(null);
	let catalogLoading = $state(true);

	async function loadModelCatalog() {
		catalogLoading = true;
		try {
			const origin = page.data.env.PUBLIC_MODEL_GATEWAY_URL?.trim() ?? '';
			modelCatalog = await fetchGatewayModelCatalog(origin);
			catalogError = null;
		} catch {
			catalogError = CATALOG_UNAVAILABLE_MESSAGE;
			modelCatalog = undefined;
		} finally {
			catalogLoading = false;
		}
	}
	let ensureSubscriptionAttemptedFor: string | null = null;

	$effect(() => {
		if (!authReady) return;
		const userId = getCurrentUserId();
		if (!userId || ensureSubscriptionAttemptedFor === userId) {
			return;
		}
		// Attempt once per signed-in user. This is a best-effort bootstrap: the
		// backend also ensures a row on first metered usage, so a failure is safe
		// to swallow and must not re-trigger the effect into a tight retry loop.
		ensureSubscriptionAttemptedFor = userId;
		void ensureMySubscription({}).catch(() => {});
	});
	const localServerRequiredMessage = 'Connect to a running Sprocket server to use this project.';
	const agentLaunchTimeoutMs = 30_000;
	type ComposerRecovery = {
		message: string;
		prompt: string;
		attachments?: ComposerAttachment[];
		storageIds?: Id<'_storage'>[];
		reasoningEffort?: string;
		fastMode?: boolean;
		selectedModel?: CatalogModelId;
		submissionId?: string;
		continuationOfRunId?: Id<'runs'>;
		autoSubmit?: boolean;
	};
	let desktopApi = $state<DesktopApi | null>(null);
	let desktopApiResolved = $state(false);
	let currentWorkspacePath = $state<string | null>(null);
	let currentRepositoryKey = $state<string | null>(null);
	let currentThreadId = $state<Id<'threadRecords'> | null>(null);
	let draftWorkspacePath = $state<string | null>(null);
	// Seed from compiled defaults; composer effects adopt live catalog defaults once loaded.
	let selectedModel = $state<CatalogModelId>(defaultModelId);
	let selectedReasoningEffort = $state<string>(defaultReasoningEffort);
	let fastMode = $state(false);
	let prompt = $state('');
	let selectedQuestionOptionId = $state<string | null>(null);
	let answeringAgentQuestion = $state(false);
	let composerContinuationOfRunId = $state<Id<'runs'> | null>(null);
	let autoSubmitComposerContinuation = $state(false);
	let currentError = $state<string | null>(null);
	const composerAttachments = new ComposerAttachments({
		getContext: () => ({
			api: desktopApi,
			userId: getCurrentUserId(),
			threadId: currentThreadId
		}),
		onError: (message) => {
			currentError = message;
		},
		localServerRequiredMessage
	});
	const submittingPromptScopes = new SvelteMap<string, number>();
	const composerRecoveries = new SvelteMap<string, ComposerRecovery>();
	const recoveredSubmissionIds = new SvelteMap<
		string,
		{
			prompt: string;
			storageIds: Id<'_storage'>[];
			reasoningEffort: string;
			fastMode: boolean;
			selectedModel: CatalogModelId;
			submissionId: string;
			continuationOfRunId?: Id<'runs'>;
		}
	>();
	const latestSubmissionSequencesByRecoveryScope = new SvelteMap<string, number>();
	let pendingAgentLaunches = $state<PendingAgentLaunches>({});
	let nextAgentLaunchId = 0;
	let nextSubmissionSequence = 0;
	let hasResolvedInitialSelection = $state(false);
	let lastSyncedComposerThreadId: Id<'threadRecords'> | null = null;
	let projectSelectionGeneration = $state(0);
	let pendingCreatedThreadId = $state<Id<'threadRecords'> | null>(null);
	let desktopProjectAttachmentsByPath = $state<Record<string, ProjectAttachment>>({});
	let hasLoadedDesktopProjectAttachments = $state(false);
	let desktopProjectAttachmentsGeneration = 0;
	let projectAttachmentsLoadedForUserId = $state<string | null>(null);
	let selectionUserId = $state<string | null>(null);
	let projectPickerOpen = $state(false);
	let projectPickerMode = $state<'add' | 'reconnect'>('add');
	let projectPickerExpectedDisplayName = $state<string | undefined>(undefined);
	let projectPickerReconnectWorkspacePath = $state<string | null>(null);
	let settingsOpen = $state(false);
	let settingsPage = $state<SettingsPage>('account');
	let sidebarOpen = $state(true);
	let viewportWidth = $state(0);
	let projectFilter = $state<string[]>([]);
	let settledInboxOpen = $state(false);
	let pendingProjectLaunches = $state<string[]>([]);
	let projectLaunchInFlight = $state(false);
	let initialProjectLaunchResolved = $state(false);
	let createThreadComposerElement = $state<HTMLElement | null>(null);
	const remoteChangeNotices = new SvelteMap<Id<'threadRecords'>, string>();
	const REMOTE_CHANGE_NOTICE =
		'This directory’s git remote changed. Existing threads now follow the new repository.';
	function getCurrentUserId() {
		return signedInUserId;
	}

	function getComposerScope(threadId: Id<'threadRecords'> | null, workspacePath: string | null) {
		return threadId ? `thread:${threadId}` : workspacePath ? `draft:${workspacePath}` : null;
	}

	function clearSubmittingPrompt(scope: string, submissionSequence: number) {
		if (submittingPromptScopes.get(scope) === submissionSequence) {
			submittingPromptScopes.delete(scope);
		}
	}

	function getComposerRecoveryKey(userId: string, scope: string) {
		return `${userId}\0${scope}`;
	}

	function storeComposerRecovery(userId: string, scope: string, recovery: ComposerRecovery) {
		composerRecoveries.set(getComposerRecoveryKey(userId, scope), recovery);
	}

	function clearComposerRecovery(userId: string, scope: string) {
		const recoveryKey = getComposerRecoveryKey(userId, scope);
		composerRecoveries.delete(recoveryKey);
		recoveredSubmissionIds.delete(recoveryKey);
	}

	function getAuthenticatedQueryArgs() {
		return signedInUserId && convexAuth.isAuthenticated && !convexAuth.isLoading ? {} : 'skip';
	}

	const uiPreferencesQuery = useQuery(api.uiPreferences.getMine, getAuthenticatedQueryArgs);
	let workspaceTheme = $state<SprocketTheme>(resolveTheme(null));
	let hasHydratedTheme = false;
	let lastServerTheme: SprocketTheme | null | undefined = undefined;
	let pendingTheme: SprocketTheme | null = null;
	let themeSaveGeneration = 0;

	$effect(() => {
		if (!authReady) {
			hasHydratedTheme = false;
			lastServerTheme = undefined;
			pendingTheme = null;
			themeSaveGeneration = 0;
			return;
		}

		const preferences = uiPreferencesQuery.data;

		// Wait for Convex before applying a workspace theme (boot script stays light for entry).
		if (preferences === undefined) {
			return;
		}

		// Ignore preference snapshots while a theme save is in flight.
		if (pendingTheme !== null) {
			return;
		}

		const serverTheme = preferences?.theme;
		if (hasHydratedTheme && serverTheme === lastServerTheme) {
			return;
		}
		hasHydratedTheme = true;
		lastServerTheme = serverTheme;

		const nextTheme = resolveTheme(serverTheme);
		workspaceTheme = nextTheme;
		applyTheme(nextTheme);
	});

	async function handleThemeChange(theme: SprocketTheme) {
		const previous = workspaceTheme;
		const generation = ++themeSaveGeneration;
		pendingTheme = theme;
		workspaceTheme = theme;
		applyTheme(theme);
		try {
			await setThemePreference({ theme });
			if (generation !== themeSaveGeneration) {
				return;
			}
			lastServerTheme = theme;
		} catch (error) {
			if (generation !== themeSaveGeneration) {
				return;
			}
			workspaceTheme = previous;
			applyTheme(previous);
			currentError = error instanceof Error ? error.message : 'Failed to save theme preference.';
		} finally {
			if (generation === themeSaveGeneration) {
				pendingTheme = null;
			}
		}
	}

	const authenticatedThreadQueryArgs = () =>
		currentThreadId && getAuthenticatedQueryArgs() !== 'skip'
			? { threadId: currentThreadId }
			: 'skip';
	const activeThreadQuery = useQuery(api.threads.getByThreadId, authenticatedThreadQueryArgs);
	const lifecycleQuery = useQuery(api.chat.selectedThreadLifecycle, authenticatedThreadQueryArgs);
	const browserLiveViewQuery = useQuery(
		api.browserSessions.liveViewForThread,
		authenticatedThreadQueryArgs
	);
	const pendingAgentQuestionQuery = useQuery(
		api.agentQuestions.headPendingForThread,
		authenticatedThreadQueryArgs
	);
	const queryError = $derived.by(() => {
		for (const query of [
			uiPreferencesQuery,
			activeThreadQuery,
			lifecycleQuery,
			browserLiveViewQuery,
			pendingAgentQuestionQuery
		]) {
			if (query.error) {
				return query.error;
			}
		}

		return null;
	});
	const createThreadError = $derived(
		currentError ??
			$authState.error ??
			(queryError instanceof Error ? convexClientErrorMessage(queryError) : null)
	);
	const projects = $derived.by<ProjectState[]>(() =>
		Object.values(desktopProjectAttachmentsByPath)
			.sort((left, right) => right.lastUsedAt - left.lastUsedAt)
			.map(projectFromAttachment)
	);
	const inboxProjects = $derived([
		...new Map(projects.map((project) => [project.repositoryKey, project])).values()
	]);
	const inboxProjectKeys = $derived(
		projectFilter.length > 0 ? projectFilter : inboxProjects.map((project) => project.repositoryKey)
	);
	$effect(() => {
		const attachedKeys = new Set(inboxProjects.map((project) => project.repositoryKey));
		const attachedFilter = projectFilter.filter((key) => attachedKeys.has(key));
		if (attachedFilter.length !== projectFilter.length) projectFilter = attachedFilter;
	});
	const inbox = useThreadInbox({
		enabled: () => authReady,
		projects: () => inboxProjectKeys,
		settledOpen: () => settledInboxOpen
	});
	const currentActiveThread = $derived(dataForThread(activeThreadQuery.data, currentThreadId));
	const threads = $derived.by<ThreadSummary[]>(() => {
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
	});
	const currentLifecycle = $derived(dataForThread(lifecycleQuery.data, currentThreadId));
	const runState = $derived(currentLifecycle?.run ?? null);
	const pendingAgentQuestion = $derived(
		dataForThread(pendingAgentQuestionQuery.data, currentThreadId)
	);
	const transcript = new TranscriptReplica();

	$effect.pre(() => {
		const threadId = currentThreadId;
		if (transcript.threadId !== threadId) untrack(() => transcript.selectThread(threadId));
	});

	$effect(() => {
		const threadId = currentThreadId;
		const api = desktopApi;
		if (!threadId || !api || !isSignedIn) {
			return;
		}
		const userId = untrack(() => getCurrentUserId());
		if (!userId) return;
		return transcript.watchDisplay({
			api,
			userId,
			threadId,
			isCurrent: () => currentThreadId === threadId
		});
	});

	$effect(() => {
		const threadId = currentThreadId;
		const api = desktopApi;
		if (!threadId || !api || !isSignedIn) {
			return;
		}
		const userId = untrack(() => getCurrentUserId());
		if (!userId) return;
		return transcript.watchLiveCompletion({
			api,
			userId,
			threadId,
			isCurrent: () => currentThreadId === threadId
		});
	});

	$effect(() => {
		const overlays = transcript.overlays;
		untrack(() => transcript.syncOverlays(overlays));
	});

	const visibleMessages = $derived(
		transcript.visibleMessages({
			threadId: currentThreadId,
			userId: getCurrentUserId(),
			run: runState
		})
	);

	const currentProject = $derived.by<ProjectState | null>(() => {
		if (currentWorkspacePath) {
			return findProjectByWorkspacePath(projects, currentWorkspacePath);
		}
		if (!currentRepositoryKey) {
			return null;
		}
		return findProjectByRepositoryKey(projects, currentRepositoryKey);
	});

	const currentProjectPath = $derived(currentProject?.workspacePath ?? currentWorkspacePath);
	const composerProjectSkills = $derived.by(() => {
		const workspacePath = currentProject?.workspacePath ?? null;
		const api = desktopApi;
		return {
			workspacePath,
			load: async () => {
				if (!api || !workspacePath) {
					return [];
				}
				const result = await api.listWorkspaceSkills({ workspacePath });
				for (const warning of result.warnings) {
					console.warn(`sprocket skills: ${warning}`);
				}
				return result.skills;
			}
		};
	});

	const currentProjectThreads = $derived.by<ThreadSummary[]>(() => {
		if (!currentProject?.repositoryKey) {
			return [];
		}

		return threads
			.filter(
				(thread) => thread.repositoryKey === currentProject.repositoryKey && isActiveThread(thread)
			)
			.sort((left, right) => right.lastMessageAt - left.lastMessageAt);
	});

	const visibleActions: ExecutorJob[] = [];
	const artifactPanel = new ArtifactPanel();

	$effect(() => {
		const scope =
			signedInUserId && currentRepositoryKey
				? {
						userId: signedInUserId,
						repositoryKey: currentRepositoryKey,
						workspacePath: currentWorkspacePath ?? '',
						threadId: currentThreadId
					}
				: null;
		artifactPanel.selectScope(scope);
	});

	$effect(() => {
		const scope =
			signedInUserId && currentRepositoryKey
				? {
						userId: signedInUserId,
						repositoryKey: currentRepositoryKey,
						workspacePath: currentWorkspacePath ?? '',
						threadId: currentThreadId
					}
				: null;
		return artifactPanel.watch({
			localApi: desktopApi,
			artifactClient,
			cloudReady: convexAuth.isAuthenticated && !convexAuth.isLoading,
			scope
		});
	});

	const currentComposerScope = $derived(getComposerScope(currentThreadId, currentProjectPath));
	const currentRecoveredSubmission = $derived.by(() => {
		const userId = getCurrentUserId();
		if (!userId || !currentComposerScope) return undefined;
		return recoveredSubmissionIds.get(getComposerRecoveryKey(userId, currentComposerScope));
	});
	const isRetryableQueuedRun = $derived(
		currentLifecycle?.phase === 'queued' && currentRecoveredSubmission != null
	);
	const isRunInProgress = $derived(
		currentLifecycle != null &&
			isLifecycleInProgress(currentLifecycle.phase) &&
			!isRetryableQueuedRun
	);
	const isRunning = $derived(
		isRunInProgress && currentLifecycle?.phase !== 'cancellation_requested'
	);
	const runElapsedSeconds = $derived(
		isRunInProgress ? elapsedSeconds(runState?.startedAt, tickingNow()) : undefined
	);
	const hasPendingAgentLaunch = $derived(
		isAgentLaunchPending(pendingAgentLaunches, currentThreadId)
	);
	const latestRunResumeKind = $derived(
		hasPendingAgentLaunch || isRunInProgress
			? null
			: lifecycleResumeKind(currentLifecycle?.phase ?? 'idle', currentLifecycle?.run?.lastError)
	);
	const isLatestRunReady = $derived(
		isLatestRunReadyForThread({
			threadId: currentThreadId,
			pendingCreatedThreadId,
			hasLatestRunData: Boolean(currentLifecycle)
		})
	);
	const isSubmittingPrompt = $derived(
		Boolean(currentComposerScope && submittingPromptScopes.has(currentComposerScope))
	);
	const canSend = $derived(
		Boolean(
			currentProjectPath &&
			currentProject?.localAttachmentAvailability === 'available' &&
			!isSubmittingPrompt &&
			!answeringAgentQuestion &&
			!hasPendingAgentLaunch &&
			((!isRunInProgress && isLatestRunReady) || pendingAgentQuestion)
		)
	);
	const recentProjectDirectories = $derived.by(() => {
		const seen = new SvelteSet<string>();
		const recents: Array<{ workspacePath: string; displayName: string }> = [];

		for (const attachment of Object.values(desktopProjectAttachmentsByPath)) {
			if (attachment.availability !== 'available' || seen.has(attachment.workspacePath)) {
				continue;
			}

			seen.add(attachment.workspacePath);
			const displayName =
				attachment.workspacePath.split(/[/\\]/).filter(Boolean).at(-1) ?? attachment.workspacePath;
			recents.push({
				workspacePath: attachment.workspacePath,
				displayName
			});
		}

		return recents.sort((left, right) => right.displayName.localeCompare(left.displayName));
	});

	async function refreshDesktopProjectAttachments() {
		const refreshGeneration = ++desktopProjectAttachmentsGeneration;
		const nextAttachments = await refreshDesktopProjectAttachmentsFromDesktop(desktopApi);
		if (refreshGeneration !== desktopProjectAttachmentsGeneration) {
			return;
		}

		desktopProjectAttachmentsByPath = nextAttachments;
		hasLoadedDesktopProjectAttachments = true;
		await rekeyChangedLocalRepositories(nextAttachments);
	}

	$effect(() => {
		const userId = signedInUserId;
		if (!authReady || !desktopApi || !userId) {
			projectAttachmentsLoadedForUserId = null;
			return;
		}
		if (projectAttachmentsLoadedForUserId === userId) {
			return;
		}

		projectAttachmentsLoadedForUserId = userId;
		untrack(() => {
			void refreshDesktopProjectAttachments().catch((error) => {
				if (getCurrentUserId() === userId) {
					currentError =
						error instanceof Error ? error.message : 'Failed to load local project attachments.';
				}
			});
		});
	});

	async function rekeyChangedLocalRepositories(next: Record<string, ProjectAttachment>) {
		if (getAuthenticatedQueryArgs() === 'skip') {
			return;
		}
		for (const attachment of Object.values(next)) {
			const previousKey = attachment.previousRepositoryKey;
			if (!previousKey || previousKey === attachment.repositoryKey) {
				continue;
			}
			const siblingStillHasPreviousKey = Object.values(next).some(
				(candidate) =>
					candidate.workspacePath !== attachment.workspacePath &&
					candidate.repositoryKey === previousKey
			);
			if (!siblingStillHasPreviousKey && getAuthenticatedQueryArgs() !== 'skip') {
				await rekeyLocalRepository(previousKey, attachment.repositoryKey);
			}
			if (currentWorkspacePath === attachment.workspacePath) {
				currentRepositoryKey = attachment.repositoryKey;
			}
			await attachLocalProject(attachment.workspacePath);
		}
	}

	function localThreadCommandContext() {
		const api = desktopApi;
		const userId = getCurrentUserId();
		if (!api || !userId) {
			throw new Error('The local Sprocket service is not ready.');
		}
		return { api, userId };
	}

	async function signOut() {
		const api = desktopApi;
		const userId = getCurrentUserId();
		if (api && userId) {
			await api.endAccountSession({ userId }).catch(() => {});
		}
		await authSignOut();
	}

	async function rekeyLocalRepository(from: string, to: string) {
		const { api, userId } = localThreadCommandContext();
		await api.rekeyRepository({ userId, from, to });
	}

	$effect(() => {
		const api = desktopApi;
		const userId = signedInUserId;
		if (!api || !userId || !authReady) return;
		void api.startAccountSession({ userId }).catch((error) => {
			if (desktopApi === api && getCurrentUserId() === userId) {
				currentError =
					error instanceof Error ? error.message : 'Failed to register this Sprocket process.';
			}
		});
	});

	function applyProjectSelection(
		workspacePath: string,
		threadId: Id<'threadRecords'> | null = null,
		draft: boolean = false
	) {
		const project = findProjectByWorkspacePath(projects, workspacePath);
		currentWorkspacePath = workspacePath;
		currentRepositoryKey = project?.repositoryKey ?? null;
		currentThreadId = threadId;
		draftWorkspacePath = draft ? workspacePath : null;
		if (threadId !== pendingCreatedThreadId) {
			pendingCreatedThreadId = null;
		}
	}

	function setProjectSelection(
		workspacePath: string,
		threadId: Id<'threadRecords'> | null = null,
		draft: boolean = false,
		preserveError: boolean = false
	) {
		projectSelectionGeneration += 1;
		if (!preserveError) {
			currentError = null;
		}
		applyProjectSelection(workspacePath, threadId, draft);
	}

	async function attachLocalProject(workspacePath: string, replaceWorkspacePath?: string) {
		if (!desktopApi) {
			throw new Error(localServerRequiredMessage);
		}

		const attachment = await attachLocalProjectForPath({
			desktopApi,
			workspacePath,
			replaceWorkspacePath
		});
		desktopProjectAttachmentsGeneration += 1;
		desktopProjectAttachmentsByPath = upsertDesktopProjectAttachment(
			desktopProjectAttachmentsByPath,
			attachment,
			replaceWorkspacePath
		);
		hasLoadedDesktopProjectAttachments = true;
		return attachment;
	}

	function openProject(
		workspacePath: string,
		selection: { threadId?: Id<'threadRecords'> | null; draft?: boolean } = {}
	) {
		const project = findProjectByWorkspacePath(projects, workspacePath);
		if (!project) {
			currentError = 'Choose a project first.';
			return;
		}

		setProjectSelection(workspacePath, selection.threadId, selection.draft);
		const selectionGeneration = projectSelectionGeneration;
		void verifyProject(project.workspacePath).catch((error) => {
			if (selectionGeneration === projectSelectionGeneration) {
				currentError = error instanceof Error ? error.message : 'Failed to attach project.';
			}
		});
	}

	function openProjectPicker(
		mode: 'add' | 'reconnect' = 'add',
		workspacePath: string | null = null
	) {
		if (!desktopApi) {
			currentError = localServerRequiredMessage;
			return;
		}

		projectPickerMode = mode;
		projectPickerReconnectWorkspacePath = workspacePath;
		const reconnectProject =
			mode === 'reconnect' && workspacePath
				? findProjectByWorkspacePath(projects, workspacePath)
				: undefined;
		projectPickerExpectedDisplayName = reconnectProject?.displayName;
		projectPickerOpen = true;
		currentError = null;
	}

	async function handleProjectSelected(selection: ProjectSelection) {
		if (!desktopApi) {
			currentError = localServerRequiredMessage;
			return;
		}
		const pickerUserId = getCurrentUserId();
		if (!pickerUserId) {
			currentError = 'User session is not ready.';
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
			if (getCurrentUserId() !== pickerUserId) {
				return;
			}
			currentError = error instanceof Error ? error.message : 'Failed to attach project.';
			throw error;
		}
	}

	async function addProjectSelection(selection: ProjectSelection, expectedUserId: string) {
		await attachLocalProject(selection.workspacePath);
		if (getCurrentUserId() !== expectedUserId) {
			return;
		}
		setProjectSelection(selection.workspacePath, null, true);
		currentError = null;
	}

	async function reconnectProjectSelection(
		selection: ProjectSelection,
		previousWorkspacePath: string,
		expectedUserId: string
	) {
		const previousProject = findProjectByWorkspacePath(projects, previousWorkspacePath);
		await attachLocalProject(
			selection.workspacePath,
			previousWorkspacePath === selection.workspacePath ? undefined : previousWorkspacePath
		);
		if (getCurrentUserId() !== expectedUserId) {
			return;
		}
		if (
			previousProject &&
			previousProject.repositoryKey !== selection.repositoryKey &&
			getAuthenticatedQueryArgs() !== 'skip' &&
			!projects.some(
				(project) =>
					project.workspacePath !== selection.workspacePath &&
					project.repositoryKey === previousProject.repositoryKey
			)
		) {
			await rekeyLocalRepository(previousProject.repositoryKey, selection.repositoryKey);
		}
		const keepThread =
			previousProject?.repositoryKey === selection.repositoryKey ? currentThreadId : null;
		setProjectSelection(selection.workspacePath, keepThread);
		currentError = null;
	}

	function queueProjectLaunch(workspacePath: string | null | undefined) {
		const normalizedPath = workspacePath?.trim();
		if (!normalizedPath) {
			return;
		}

		pendingProjectLaunches = [...pendingProjectLaunches, normalizedPath];
	}

	async function takeDesktopProjectLaunches() {
		const bridge = window.sprocketDesktopBridge;
		if (!bridge?.takeWorkspaceLaunch) {
			return;
		}

		while (true) {
			const workspacePath = await bridge.takeWorkspaceLaunch();
			if (!workspacePath) {
				return;
			}
			queueProjectLaunch(workspacePath);
		}
	}

	async function openLaunchedProject(workspacePath: string, client: DesktopApi, userId: string) {
		const selection = await client.resolveWorkspacePath({ workspacePath });
		if (getCurrentUserId() !== userId) {
			return;
		}
		await addProjectSelection(selection, userId);
	}

	async function verifyProject(workspacePath: string) {
		await verifyProjectAttachmentForExecution({
			desktopApi,
			refreshDesktopProjectAttachments,
			workspacePath
		});
	}

	function reconnectProject(workspacePath: string) {
		openProjectPicker('reconnect', workspacePath);
	}

	async function persistSelectedModel(modelId: CatalogModelId) {
		const threadId = currentThreadId;
		const userId = getCurrentUserId();
		if (!threadId || !userId) {
			return;
		}

		try {
			await setThreadSelectedModel({ threadId, selectedModel: modelId });
		} catch (error) {
			if (currentThreadId === threadId && getCurrentUserId() === userId) {
				currentError =
					error instanceof Error ? error.message : 'Failed to save the selected model.';
			}
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
		if (matchMedia('(max-width: 767px)').matches) sidebarOpen = false;
	}

	async function focusCreateThreadComposer() {
		await tick();
		createThreadComposerElement?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
	}

	function selectThread(thread: ThreadSummary, workspacePath: string) {
		openProject(workspacePath, { threadId: thread.threadId });
	}

	function selectInboxThread(thread: Doc<'threadRecords'>) {
		const project = findProjectByRepositoryKey(projects, thread.repositoryKey);
		if (!project) return;
		selectThread(threadRecordToSummary(thread), project.workspacePath);
		if (matchMedia('(max-width: 767px)').matches) sidebarOpen = false;
	}

	async function renameThread(threadId: Id<'threadRecords'>, title: string) {
		try {
			await renameThreadRecord({ threadId, title });
		} catch (error) {
			currentError = error instanceof Error ? error.message : 'Failed to rename thread.';
			throw error;
		}
	}

	async function loadOlderTranscript() {
		await transcript.loadOlder();
	}

	async function loadTranscriptAttachment(storageId: Id<'_storage'>) {
		const api = desktopApi;
		const threadId = currentThreadId;
		const userId = getCurrentUserId();
		if (!api || !threadId || !userId) {
			return null;
		}
		const blob = await api.fetchTranscriptAttachment({
			userId,
			threadId,
			storageId
		});
		return blob ? URL.createObjectURL(blob) : null;
	}

	async function loadTranscriptSectionDetails(
		row: TranscriptDisplayRow,
		cursor: TranscriptDetailCursor,
		signal: AbortSignal
	) {
		const api = desktopApi;
		const threadId = currentThreadId;
		const userId = getCurrentUserId();
		if (!api || !threadId || !userId || row.threadId !== threadId)
			throw new Error('Thread is no longer selected.');
		return await api.fetchTranscriptDisplayDetails(
			{ userId, threadId, rowId: row.id, ...cursor },
			signal
		);
	}

	async function changeInboxState(thread: Doc<'threadRecords'>, state: InboxState) {
		const expectedUserId = getCurrentUserId();
		try {
			const request = { threadId: thread._id };
			if (state === 'settled') await settleThreadRecord(request);
			else await unsettleThreadRecord(request);
			if (getCurrentUserId() === expectedUserId) {
				if (state === 'settled' && currentThreadId === thread._id) {
					currentThreadId = null;
					draftWorkspacePath = currentWorkspacePath;
					projectSelectionGeneration += 1;
				}
				currentError = null;
			}
		} catch (error) {
			if (getCurrentUserId() !== expectedUserId) {
				return;
			}
			currentError = error instanceof Error ? error.message : 'Failed to update thread.';
			throw error;
		}
	}

	async function submitAgentQuestionAnswer() {
		const question = pendingAgentQuestion;
		const threadId = currentThreadId;
		const userId = getCurrentUserId();
		if (!question || !threadId || !userId || answeringAgentQuestion) {
			return;
		}
		if (!selectedQuestionOptionId && !prompt.trim()) {
			return;
		}

		answeringAgentQuestion = true;
		currentError = null;
		const submittedPrompt = prompt;
		const submittedOptionId = selectedQuestionOptionId;
		const answerText = submittedPrompt.trim();
		const submittedAttachments = composerAttachments.snapshot();
		const submittedStorageIds = submittedAttachments.flatMap((attachment) =>
			attachment.storageId ? [attachment.storageId] : []
		);
		const submittedModel = selectedModel;
		const submittedReasoningEffort = selectedReasoningEffort;
		const submittedFastMode = fastMode;
		let continuationPrompt: string | null = null;
		let continuationOfRunId: Id<'runs'> | undefined;
		prompt = '';
		selectedQuestionOptionId = null;
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
				currentThreadId === threadId &&
				pendingAgentQuestion?.questionId === question.questionId
			) {
				prompt = submittedPrompt;
				selectedQuestionOptionId = submittedOptionId;
				currentError = error instanceof Error ? error.message : String(error);
			}
		} finally {
			answeringAgentQuestion = false;
		}
		if (continuationPrompt !== null && currentThreadId !== threadId) {
			storeComposerRecovery(userId, `thread:${threadId}`, {
				message: 'Continuing from your answer when you return to this thread.',
				prompt: continuationPrompt,
				attachments: submittedAttachments,
				storageIds: submittedStorageIds,
				reasoningEffort: submittedReasoningEffort,
				fastMode: submittedFastMode,
				selectedModel: submittedModel,
				continuationOfRunId,
				autoSubmit: true
			});
			return;
		}
		if (continuationPrompt !== null) {
			composerContinuationOfRunId = continuationOfRunId ?? null;
			prompt = continuationPrompt;
			await submitPrompt({ answeredQuestionId: question.questionId, continuationOfRunId });
		}
	}

	async function submitPrompt(options?: {
		answeredQuestionId: Id<'agentQuestions'>;
		continuationOfRunId: Id<'runs'> | undefined;
	}) {
		if (pendingAgentQuestion) {
			if (
				options?.answeredQuestionId &&
				pendingAgentQuestion.questionId !== options.answeredQuestionId
			) {
				currentError = 'Answer the new agent question before continuing.';
				return;
			}
			if (!options?.answeredQuestionId) {
				await submitAgentQuestionAnswer();
				return;
			}
		}

		if (isSubmittingPrompt) {
			return;
		}

		if (!prompt.trim() && composerAttachments.items.length === 0) {
			return;
		}

		if (composerAttachments.items.some((attachment) => attachment.status !== 'ready')) {
			currentError = 'Wait for file uploads to finish, or remove failed files before sending.';
			return;
		}

		const workspacePath = currentProjectPath;
		if (!workspacePath) {
			currentError = 'Choose a project first.';
			return;
		}

		if (!desktopApi) {
			currentError = localServerRequiredMessage;
			return;
		}

		if (currentThreadId && !isLatestRunReady) {
			currentError = 'Loading thread state before sending.';
			return;
		}

		if (!canSend) {
			currentError =
				isRunInProgress || hasPendingAgentLaunch || isSubmittingPrompt
					? 'Wait for the current agent launch or run to finish.'
					: currentProject?.localAttachmentAvailability === 'available'
						? 'You need an active project before sending.'
						: 'This project needs to be attached before sending.';
			return;
		}

		const selectedThreadId = currentThreadId;
		let submittedRepositoryKey = currentRepositoryKey;
		if (!submittedRepositoryKey) {
			currentError = 'Choose a project first.';
			return;
		}
		let repositoryKeyChanged = false;
		const submittedUserId = getCurrentUserId();
		if (!submittedUserId) {
			currentError = 'User session is not ready.';
			return;
		}
		const isSubmittedUserCurrent = () => getCurrentUserId() === submittedUserId;
		const submittedPrompt = prompt.trim();
		const submittedAttachments = composerAttachments.snapshot();
		const submittedStorageIds = submittedAttachments.flatMap((attachment) =>
			attachment.storageId ? [attachment.storageId] : []
		);
		const submittedModel = selectedModel;
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
			continuationOfRunId: submittedContinuationOfRunId,
			recoveredSubmission: recoveredSubmission
				? {
						...recoveredSubmission,
						selectedModel: recoveredSubmission.selectedModel
					}
				: undefined,
			selectedModel: submittedModel
		});
		const runSubmissionId = threadSubmissionId;
		clearComposerRecovery(submittedUserId, originatingRecoveryScope);
		let launchedThreadId: Id<'threadRecords'> | null = null;
		let agentLaunchId: number | null = null;
		const submissionSequence = ++nextSubmissionSequence;
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
			if (isSubmittedUserCurrent() && currentError === submissionDelayMessage) {
				currentError = null;
			}
		};
		const submissionTimeoutId = window.setTimeout(() => {
			if (
				latestSubmissionSequencesByRecoveryScope.get(submissionTrackingKey) !== submissionSequence
			) {
				return;
			}

			recoverSubmission(submissionDelayMessage);
			clearSubmittingPrompt(submissionScope, submissionSequence);
			latestSubmissionSequencesByRecoveryScope.delete(submissionTrackingKey);
		}, agentLaunchTimeoutMs);
		prompt = '';
		currentError = null;
		submittingPromptScopes.set(submissionScope, submissionSequence);

		try {
			if (!selectedThreadId) {
				const resolution = await desktopApi.resolveWorkspacePath({ workspacePath });
				if (!isSubmissionCurrent()) {
					return;
				}
				if (resolution.repositoryKey !== submittedRepositoryKey) {
					await refreshDesktopProjectAttachments();
					if (!isSubmissionCurrent()) {
						return;
					}
					submittedRepositoryKey = resolution.repositoryKey;
					currentRepositoryKey = resolution.repositoryKey;
					repositoryKeyChanged = true;
				}
			}

			const threadId = selectedThreadId;
			if (!isSubmissionCurrent()) {
				return;
			}
			if (!isSubmittedUserCurrent()) {
				recoverSubmission(sessionChangedMessage);
				return;
			}
			launchedThreadId = threadId;
			if (!isSubmissionCurrent()) {
				return;
			}
			if (!isSubmittedUserCurrent()) {
				recoverSubmission(sessionChangedMessage);
				return;
			}
			clearSubmissionDelay();
			const launchId = ++nextAgentLaunchId;
			agentLaunchId = launchId;
			const launch: PendingAgentLaunch = {
				expiresAt: Date.now() + agentLaunchTimeoutMs,
				launchId,
				previousRunId
			};
			if (runState?.startedAt) {
				launch.previousStartedAt = runState.startedAt;
			}
			if (threadId)
				pendingAgentLaunches = beginPendingAgentLaunch(pendingAgentLaunches, threadId, launch);
			if (threadId)
				window.setTimeout(() => {
					const selectedRunId = currentThreadId === threadId ? (runState?.runId ?? null) : null;
					const latestRunId = selectedRunId;
					const latestStartedAt =
						currentThreadId === threadId && runState?.runId === latestRunId
							? runState?.startedAt
							: undefined;
					const recovery = resolveExpiredAgentLaunch(
						pendingAgentLaunches,
						threadId,
						launchId,
						Date.now(),
						latestRunId,
						undefined,
						latestStartedAt
					);
					if (recovery.pendingLaunches === pendingAgentLaunches) {
						return;
					}

					pendingAgentLaunches = recovery.pendingLaunches;
					if (recovery.shouldRecover) {
						recoverSubmission('The local agent did not start. Please try again.');
					}
				}, agentLaunchTimeoutMs);
			await launchAgentRun({
				userId: submittedUserId,
				desktopApi,
				onError: (error) => {
					if (!isSubmissionCurrent() || !isSubmittedUserCurrent()) {
						return;
					}
					if (threadId) {
						const nextPendingAgentLaunches = clearPendingAgentLaunch(
							pendingAgentLaunches,
							threadId,
							launchId
						);
						if (nextPendingAgentLaunches !== pendingAgentLaunches) {
							pendingAgentLaunches = nextPendingAgentLaunches;
						}
					}
					recoverSubmission(
						error instanceof Error ? error.message : 'Failed to start the local agent run.'
					);
				},
				onStarted: (_runId, createdThreadId) => {
					if (!isSubmissionCurrent() || !isSubmittedUserCurrent()) return;
					if (!selectedThreadId) {
						launchedThreadId = createdThreadId;
						pendingCreatedThreadId = createdThreadId;
						projectSelectionGeneration += 1;
						currentThreadId = createdThreadId;
						draftWorkspacePath = null;
						if (repositoryKeyChanged)
							remoteChangeNotices.set(createdThreadId, REMOTE_CHANGE_NOTICE);
					}
					composerAttachments.clear({ discard: false });
					if (composerContinuationOfRunId === submittedContinuationOfRunId) {
						composerContinuationOfRunId = null;
						autoSubmitComposerContinuation = false;
					}
				},
				threadId: threadId ?? undefined,
				repositoryKey: threadId ? undefined : submittedRepositoryKey,
				prompt: submittedPrompt,
				storageIds: submittedStorageIds,
				selectedModel: submittedModel,
				submissionId: runSubmissionId,
				reasoningEffort: submittedReasoningEffort,
				fastMode: submittedFastMode,
				workspacePath,
				continuationOfRunId: submittedContinuationOfRunId
			});
		} catch (error) {
			if (launchedThreadId && agentLaunchId !== null) {
				pendingAgentLaunches = clearPendingAgentLaunch(
					pendingAgentLaunches,
					launchedThreadId,
					agentLaunchId
				);
			}
			if (!isSubmissionCurrent()) {
				return;
			}
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

	async function cancelRun() {
		if (!runState?.runId || !isRunInProgress) {
			return;
		}

		try {
			const { api, userId } = localThreadCommandContext();
			await api.requestRunCancellation({
				userId,
				runId: runState.runId
			});
		} catch (error) {
			currentError = error instanceof Error ? error.message : 'Failed to cancel run.';
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
			currentError = localServerRequiredMessage;
			return;
		}
		const threadId = currentThreadId;
		const workspacePath = currentProjectPath;
		const userId = getCurrentUserId();
		if (!workspacePath || !userId) {
			return;
		}
		const previousRunId = runState.runId;
		const previousStartedAt = runState.startedAt;
		const launchId = ++nextAgentLaunchId;
		const launch: PendingAgentLaunch = {
			expiresAt: Date.now() + agentLaunchTimeoutMs,
			launchId,
			previousRunId,
			previousStartedAt
		};
		pendingAgentLaunches = beginPendingAgentLaunch(pendingAgentLaunches, threadId, launch);
		try {
			if (getCurrentUserId() !== userId) {
				throw new Error('User session is not ready.');
			}
			await launchAgentRun({
				userId,
				desktopApi,
				onError: (error) => {
					pendingAgentLaunches = clearPendingAgentLaunch(pendingAgentLaunches, threadId, launchId);
					currentError = error.message;
				},
				onStarted: () => {},
				threadId,
				prompt: '',
				storageIds: [],
				selectedModel,
				reasoningEffort: selectedReasoningEffort,
				fastMode,
				submissionId: crypto.randomUUID(),
				workspacePath,
				continuationOfRunId: previousRunId
			});
		} catch (error) {
			pendingAgentLaunches = clearPendingAgentLaunch(pendingAgentLaunches, threadId, launchId);
			currentError = error instanceof Error ? error.message : 'Failed to continue the run.';
		}
	}

	$effect(() => {
		const userId = getCurrentUserId();
		if (selectionUserId === userId) {
			return;
		}

		const previousUserId = selectionUserId;
		const previousThreadId = currentThreadId;
		selectionUserId = userId;
		hasResolvedInitialSelection = false;
		currentWorkspacePath = null;
		currentRepositoryKey = null;
		currentThreadId = null;
		draftWorkspacePath = null;
		pendingCreatedThreadId = null;
		pendingAgentLaunches = {};
		ensureSubscriptionAttemptedFor = null;
		lastSyncedComposerThreadId = null;
		projectSelectionGeneration += 1;
		prompt = '';
		composerContinuationOfRunId = null;
		autoSubmitComposerContinuation = false;
		composerAttachments.clear({
			discard: true,
			userId: previousUserId,
			threadId: previousThreadId
		});
		currentError = null;
		selectedModel = modelCatalog?.defaultModelId ?? defaultModelId;
		selectedReasoningEffort = modelCatalog?.defaultReasoningEffort ?? defaultReasoningEffort;
		fastMode = false;
		projectPickerOpen = false;
		projectPickerReconnectWorkspacePath = null;
		projectPickerExpectedDisplayName = undefined;
		artifactPanel.reset();
	});

	$effect(() => {
		if (!pendingCreatedThreadId) {
			return;
		}

		const nextPendingCreatedThreadId = resolvePendingCreatedThreadId({
			pendingCreatedThreadId,
			threads
		});
		if (nextPendingCreatedThreadId !== pendingCreatedThreadId) {
			pendingCreatedThreadId = nextPendingCreatedThreadId;
		}
	});

	$effect(() => {
		const workspacePath = pendingProjectLaunches[0];
		const client = desktopApi;
		const userId = getCurrentUserId();
		if (
			!workspacePath ||
			projectLaunchInFlight ||
			!authReady ||
			!client ||
			!userId ||
			!hasLoadedDesktopProjectAttachments
		) {
			return;
		}

		pendingProjectLaunches = pendingProjectLaunches.slice(1);
		projectLaunchInFlight = true;
		hasResolvedInitialSelection = true;
		projectPickerOpen = false;
		settingsOpen = false;
		currentError = null;
		void openLaunchedProject(workspacePath, client, userId)
			.catch((error) => {
				if (getCurrentUserId() === userId) {
					hasResolvedInitialSelection = false;
					currentError =
						error instanceof Error ? error.message : 'Failed to open the requested project.';
				}
			})
			.finally(() => {
				projectLaunchInFlight = false;
			});
	});

	$effect(() => {
		const thread = currentActiveThread;
		const threadId = thread?._id ?? null;
		if (threadId === lastSyncedComposerThreadId) return;
		lastSyncedComposerThreadId = threadId;
		composerContinuationOfRunId = null;
		autoSubmitComposerContinuation = false;
		if (!thread) return;
		selectedModel = thread.selectedModel;
		selectedReasoningEffort = thread.reasoningEffort;
		fastMode = thread.fastMode ?? false;
	});

	$effect(() => {
		const userId = getCurrentUserId();
		const recoveryScope = getComposerScope(currentThreadId, currentProjectPath);
		if (!userId || !recoveryScope) {
			return;
		}

		const recoveryKey = getComposerRecoveryKey(userId, recoveryScope);
		const recovery = composerRecoveries.get(recoveryKey);
		if (!recovery) {
			return;
		}
		if (recovery.autoSubmit && prompt !== '' && prompt !== recovery.prompt) {
			return;
		}

		composerRecoveries.delete(recoveryKey);
		const canRestorePrompt = prompt === '';
		if (canRestorePrompt) {
			prompt = recovery.prompt;
		}
		if (
			composerAttachments.items.length === 0 &&
			recovery.attachments?.length &&
			(canRestorePrompt || prompt === recovery.prompt)
		) {
			composerAttachments.replace(recovery.attachments);
		}
		if (prompt === recovery.prompt) {
			composerContinuationOfRunId = recovery.continuationOfRunId ?? null;
			autoSubmitComposerContinuation =
				recovery.autoSubmit === true && recovery.continuationOfRunId !== undefined;
			if (
				recovery.submissionId &&
				(recovery.prompt || recovery.storageIds?.length) &&
				recovery.reasoningEffort &&
				recovery.selectedModel
			) {
				recoveredSubmissionIds.set(recoveryKey, {
					prompt: recovery.prompt,
					storageIds: recovery.storageIds ?? [],
					reasoningEffort: recovery.reasoningEffort,
					fastMode: recovery.fastMode ?? false,
					selectedModel: recovery.selectedModel,
					submissionId: recovery.submissionId,
					continuationOfRunId: recovery.continuationOfRunId
				});
			}
		}

		currentError = recovery.message;
	});

	$effect(() => {
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
		autoSubmitComposerContinuation = false;
		void submitPrompt();
	});

	$effect(() => {
		const selection = resolveInitialDraftSelection({
			hasResolvedInitialSelection,
			initialProjectLaunchResolved,
			hasPendingProjectLaunches: pendingProjectLaunches.length > 0,
			projectLaunchInFlight,
			hasLoadedProjects: hasLoadedDesktopProjectAttachments,
			signedInUserId,
			projects
		});
		if (!selection) {
			return;
		}

		hasResolvedInitialSelection = true;
		if (selection.workspacePath) {
			const workspacePath = selection.workspacePath;
			setProjectSelection(workspacePath, null, true, true);
			const selectionGeneration = projectSelectionGeneration;
			untrack(() => {
				void verifyProject(workspacePath).catch((error) => {
					if (selectionGeneration === projectSelectionGeneration) {
						currentError = error instanceof Error ? error.message : 'Failed to attach project.';
					}
				});
				void focusCreateThreadComposer();
			});
		}
	});

	$effect(() => {
		const activeThreadSummary = currentThreadId ? findThreadById(threads, currentThreadId) : null;
		const threadProject =
			currentProject?.repositoryKey === activeThreadSummary?.repositoryKey
				? currentProject
				: findProjectByRepositoryKey(projects, activeThreadSummary?.repositoryKey);
		if (threadProject && threadProject.workspacePath !== currentWorkspacePath) {
			setProjectSelection(
				threadProject.workspacePath,
				currentThreadId,
				draftWorkspacePath === threadProject.workspacePath
			);
		}
	});

	$effect(() => {
		const threads = currentProjectThreads;
		if (!hasResolvedInitialSelection || !currentWorkspacePath) {
			return;
		}

		const nextThreadId = resolveProjectThreadSelection({
			threads,
			currentThreadId,
			currentWorkspacePath,
			draftWorkspacePath
		});
		if (nextThreadId === currentThreadId) {
			return;
		}

		setProjectSelection(
			currentWorkspacePath,
			nextThreadId,
			draftWorkspacePath === currentWorkspacePath,
			true
		);
	});

	$effect(() => {
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
			pendingAgentLaunches = nextPendingAgentLaunches;
		}
	});

	onMount(() => {
		const media = matchMedia('(max-width: 767px)');
		sidebarOpen = !media.matches;
		viewportWidth = window.innerWidth;
		const updateViewportWidth = () => {
			viewportWidth = window.innerWidth;
		};
		window.addEventListener('resize', updateViewportWidth);
		void loadModelCatalog();
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
			void takeDesktopProjectLaunches().finally(() => {
				initialProjectLaunchResolved = true;
			});
		} else {
			initialProjectLaunchResolved = true;
		}

		void resolveDesktopApi()
			.then(async (client) => {
				desktopApi = client;
				await reconcileNativeAuthentication();
				desktopApiResolved = true;
			})
			.catch((error) => {
				currentError =
					error instanceof Error ? error.message : 'Failed to connect to the Sprocket server.';
				desktopApiResolved = true;
			});

		return () => {
			unsubscribeWorkspaceLaunch?.();
			window.removeEventListener('resize', updateViewportWidth);
		};
	});

	async function openSidebar() {
		sidebarOpen = true;
		await tick();
		document.querySelector<HTMLButtonElement>('.inbox-sidebar-host button')?.focus();
	}

	async function closeSidebar() {
		sidebarOpen = false;
		await tick();
		document.querySelector<HTMLButtonElement>('[aria-label="Open sidebar"]')?.focus();
	}
</script>

<svelte:head>
	<title>Sprocket</title>
</svelte:head>

{#if !desktopApiResolved}
	<CalmCentered
		title="Connecting to Sprocket…"
		description="Looking for a running Sprocket server on this machine."
		busy={true}
	/>
{:else if !desktopApi}
	<CalmCentered
		title="Connect to Sprocket"
		description={currentError ?? 'Open Sprocket from the desktop app or CLI to continue.'}
	/>
{:else if !authReady}
	<div class="bg-background h-screen overflow-hidden">
		<AuthGate
			authState={{
				isLoading:
					!$authState.isReady ||
					$authState.isLoading ||
					nativeAuthLoading ||
					retryPending ||
					(isSignedIn && convexAuth.isLoading),
				isConfigured: $authState.isConfigured,
				isAuthenticated: isSignedIn,
				connectionFailed: authGateBlocked,
				error: $authState.error
			}}
			overlayOpen={$authState.isWaitingForBrowserSignIn}
			onSignIn={() => void signIn()}
			onSignOut={() => void signOut()}
			onRetry={() => void (nativeSignInRequired ? signIn() : retryConvexAuthentication())}
			retryLabel={nativeSignInRequired ? 'Finish sign-in' : 'Retry'}
			onSignUp={() => void signUp()}
		/>
		<BrowserSignInOverlay
			open={$authState.isWaitingForBrowserSignIn}
			signInUrl={$authState.browserSignInUrl}
			error={$authState.error}
			onCancel={cancelDesktopSignIn}
			onClearOpenError={clearDesktopSignInOpenError}
		/>
	</div>
{:else}
	<div class="relative h-screen overflow-hidden">
		<div
			class="app-workspace-shell inbox-layout {!settingsOpen &&
			artifactPanel.panel.open &&
			!artifactPanel.panel.expanded
				? 'pr-[20rem]'
				: ''}"
			class:sidebar-hidden={!sidebarOpen}
			class:settings-open={settingsOpen}
			inert={artifactPanel.fullscreenArtifact ||
			(artifactPanel.panel.open && artifactPanel.panel.expanded)
				? true
				: undefined}
		>
			{#if sidebarOpen}
				<button
					class="fixed inset-0 z-[140] bg-black/40 md:hidden"
					type="button"
					aria-label="Close sidebar"
					onclick={() => void closeSidebar()}
				></button>
			{/if}
			<div class="inbox-sidebar-host" inert={!sidebarOpen && viewportWidth < 768}>
				{#if settingsOpen}
					<SettingsSidebar
						activePage={settingsPage}
						theme={workspaceTheme}
						onThemeChange={(theme) => void handleThemeChange(theme)}
						onBack={() => {
							settingsOpen = false;
							settingsPage = 'account';
						}}
						onNavigate={(nextPage) => {
							settingsPage = nextPage;
							if (matchMedia('(max-width: 767px)').matches) sidebarOpen = false;
						}}
					/>
				{:else}
					<InboxSidebar
						sections={inbox.sections}
						projects={inboxProjects}
						models={modelCatalog?.models ?? []}
						selectedProjects={projectFilter}
						{currentThreadId}
						bind:settledOpen={settledInboxOpen}
						mutationsEnabled={authReady}
						theme={workspaceTheme}
						onThemeChange={(theme) => void handleThemeChange(theme)}
						onFilter={(keys) => (projectFilter = keys)}
						onSelect={selectInboxThread}
						onNew={startThreadDraft}
						onAddProject={() => openProjectPicker('add')}
						onSettings={() => {
							settingsPage = 'account';
							settingsOpen = true;
						}}
						onChange={changeInboxState}
						onRename={(thread, title) => renameThread(thread._id, title)}
					/>
				{/if}
			</div>

			<main
				class="relative flex h-screen min-h-0 min-w-0 flex-col overflow-hidden"
				inert={sidebarOpen && viewportWidth < 768}
			>
				{#if !sidebarOpen}
					<button
						class="inbox-icon absolute top-3 left-3 z-50 md:hidden"
						type="button"
						aria-label="Open sidebar"
						onclick={() => void openSidebar()}><PanelLeft size={18} /></button
					>
				{/if}
				{#if !settingsOpen && !artifactPanel.panel.open}
					<button
						type="button"
						class="text-muted-foreground hover:text-foreground hover:bg-muted absolute top-3 right-3 z-100 inline-flex items-center justify-center rounded-md p-2 transition"
						onclick={() => {
							artifactPanel.update({ open: true });
						}}
						aria-label="Open side panel"
					>
						<PanelRight class="size-4" aria-hidden="true" />
					</button>
				{/if}
				{#if settingsOpen}
					{#if settingsPage === 'usage'}
						<SettingsUsage />
					{:else if settingsPage === 'browser'}
						<SettingsBrowser />
					{:else if settingsPage === 'payments'}
						<SettingsPayments />
					{:else}
						<SettingsAccount user={$authState.user} onSignOut={() => void signOut()} />
					{/if}
				{:else}
					{#if currentThreadId}
						{#key `${currentThreadId}:${transcript.windowVersion}`}
							<ThreadTranscript
								currentError={transcript.error ??
									currentError ??
									$authState.error ??
									(queryError instanceof Error ? convexClientErrorMessage(queryError) : null) ??
									null}
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
								remoteChangeNotice={currentThreadId
									? (remoteChangeNotices.get(currentThreadId) ?? null)
									: null}
								onDismissRemoteChangeNotice={() => {
									if (currentThreadId) {
										remoteChangeNotices.delete(currentThreadId);
									}
								}}
								stale={transcript.stale}
								loadingOlder={transcript.loadingOlder}
								nextBefore={transcript.nextBefore ?? undefined}
								emptyStateMessage={currentThreadId &&
								(transcript.loading || transcript.threadId !== currentThreadId)
									? 'Loading conversation history...'
									: currentProject
										? 'Start a thread and ask Sprocket to inspect code, edit files, or run project commands.'
										: 'Add a project to begin.'}
								onLoadOlder={() => {
									void loadOlderTranscript();
								}}
								loadAttachment={loadTranscriptAttachment}
								loadSectionDetails={loadTranscriptSectionDetails}
							/>
						{/key}
					{/if}

					<div class={!currentThreadId ? 'create-thread-screen' : ''}>
						{#if !currentThreadId}
							<CreateThreadHeading
								{projects}
								workspacePath={currentWorkspacePath}
								onProject={startThreadDraftForProject}
								onAddProject={() => openProjectPicker('add')}
							/>
							{#if currentProject?.localAttachmentAvailability === 'unavailable'}
								<p class="create-thread-message">
									Project not connected here.
									<button
										type="button"
										onclick={() => {
											if (currentWorkspacePath) reconnectProject(currentWorkspacePath);
										}}>Connect a local folder</button
									>
									to start local work.
								</p>
							{/if}
							{#if createThreadError}
								<p class="create-thread-message text-destructive" role="alert">
									{createThreadError}
								</p>
							{/if}
						{/if}

						{#if catalogError}
							<div
								role="alert"
								class="text-destructive mb-3 flex items-center justify-between gap-3 rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm"
							>
								<span>{CATALOG_UNAVAILABLE_MESSAGE}</span>
								<Button
									variant="outline"
									className="h-8 px-3"
									disabled={catalogLoading}
									onclick={() => {
										void loadModelCatalog();
									}}
								>
									{catalogLoading ? 'Retrying…' : 'Retry'}
								</Button>
							</div>
						{:else if catalogLoading && !modelCatalog}
							<div class="text-muted-foreground mb-3 text-sm">Loading models…</div>
						{/if}

						<div
							bind:this={createThreadComposerElement}
							class={!currentThreadId ? 'create-thread-composer' : ''}
						>
							<PromptComposer
								bind:prompt
								attachments={composerAttachments.items}
								onAttachFiles={(files) => composerAttachments.add(files)}
								onRemoveAttachment={(localId) => composerAttachments.remove(localId)}
								{modelCatalog}
								bind:selectedModel
								onModelChange={(modelId) => {
									void persistSelectedModel(modelId);
								}}
								bind:selectedReasoningEffort
								bind:fastMode
								pendingQuestion={pendingAgentQuestion}
								showContinueWorking={latestRunResumeKind != null}
								onContinueWorking={() => {
									void continueWorking();
								}}
								bind:selectedQuestionOptionId
								{canSend}
								isSubmitting={isSubmittingPrompt || hasPendingAgentLaunch || answeringAgentQuestion}
								isStarting={hasPendingAgentLaunch}
								{isRunning}
								elapsedLabel={runElapsedSeconds === undefined
									? null
									: formatElapsedDuration(runElapsedSeconds)}
								projectSkills={composerProjectSkills}
								onSubmit={() => {
									void submitPrompt();
								}}
								onCancel={() => {
									void cancelRun();
								}}
							/>
						</div>
					</div>
				{/if}
			</main>
		</div>

		{#if !settingsOpen && artifactPanel.panel.open}
			<div
				class={artifactPanel.panel.expanded
					? 'bg-background fixed inset-0 z-50'
					: 'absolute inset-y-0 right-0 z-40 w-[20rem]'}
				inert={artifactPanel.fullscreenArtifact ? true : undefined}
			>
				<SidePanel
					artifacts={artifactPanel.artifacts}
					selectedKey={artifactPanel.panel.selectedKey}
					tab={artifactPanel.panel.tab}
					liveView={currentThreadId ? browserLiveViewQuery.data : null}
					liveActive={isRunning && browserLiveViewQuery.data?.lastUsedRunId === runState?.runId}
					expanded={artifactPanel.panel.expanded}
					stale={artifactPanel.watchState.stale}
					error={artifactPanel.watchState.error}
					onSelect={(key) => {
						artifactPanel.update({ selectedKey: key });
					}}
					onBack={() => {
						artifactPanel.update({ selectedKey: null });
					}}
					onTabChange={(tab) => {
						artifactPanel.update({ tab });
					}}
					onOpenFullscreen={(key) => {
						artifactPanel.fullscreenKey = key;
						// Request in the click gesture so Firefox keeps true browser
						// fullscreen; the overlay only observes/exits the session.
						if (!document.fullscreenElement) {
							void document.documentElement.requestFullscreen?.().catch(() => {});
						}
					}}
					onToggleExpanded={() => {
						artifactPanel.update({ expanded: !artifactPanel.panel.expanded });
					}}
					onClose={() => {
						artifactPanel.update({ open: false, expanded: false });
					}}
				/>
			</div>
		{/if}

		{#if artifactPanel.fullscreenArtifact}
			<!-- No {#key}: remounting would exit document fullscreen during artifact switches. -->
			<ArtifactScreenFullscreen
				artifact={artifactPanel.fullscreenArtifact}
				onClose={() => {
					artifactPanel.fullscreenKey = null;
				}}
			/>
		{/if}

		{#if desktopApi && projectPickerOpen}
			<ProjectPicker
				open={projectPickerOpen}
				{desktopApi}
				mode={projectPickerMode}
				expectedDisplayName={projectPickerExpectedDisplayName}
				recentProjectPaths={recentProjectDirectories}
				onClose={() => {
					projectPickerOpen = false;
					projectPickerReconnectWorkspacePath = null;
					projectPickerExpectedDisplayName = undefined;
				}}
				onSelect={async (selection) => {
					try {
						await handleProjectSelected(selection);
					} catch {
						await refreshDesktopProjectAttachments();
					}
				}}
			/>
		{/if}
	</div>
{/if}
