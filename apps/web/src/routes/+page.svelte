<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { page } from '$app/state';
	import { PanelRight } from '@lucide/svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { useAuth, useMutation, useQuery } from 'convex-svelte';
	import type { Id } from '$convex/_generated/dataModel';
	import { api } from '$convex/_generated/api';
	import { EXECUTOR_HEARTBEAT_WRITE_THROTTLE_MS } from '$convex/lib/projectConnection';
	import {
		advanceConvexAuthRetryPending,
		authState,
		cancelDesktopSignIn,
		clearDesktopSignInOpenError,
		convexAuthRetryPending,
		getAccessToken,
		retryConvexAuthentication,
		signIn,
		signOut,
		signUp
	} from '$lib/auth';
	import AuthGate from '$lib/components/home/auth-gate.svelte';
	import BrowserSignInOverlay from '$lib/components/home/browser-signin-overlay.svelte';
	import CalmCentered from '$lib/components/home/calm-centered.svelte';
	import PromptComposer from '$lib/components/home/prompt-composer.svelte';
	import SettingsAccount from '$lib/components/home/settings-account.svelte';
	import SettingsArchived from '$lib/components/home/settings-archived.svelte';
	import SettingsPayments from '$lib/components/home/settings-payments.svelte';
	import SettingsSidebar, { type SettingsPage } from '$lib/components/home/settings-sidebar.svelte';
	import SettingsUsage from '$lib/components/home/settings-usage.svelte';
	import ThreadTranscript from '$lib/components/home/thread-transcript.svelte';
	import ArtifactPanel from '$lib/components/home/artifact-panel.svelte';
	import ArtifactScreenFullscreen from '$lib/components/home/artifact-screen-fullscreen.svelte';
	import {
		DEFAULT_ARTIFACT_PANEL_SNAPSHOT,
		nextArtifactRevisionWatch,
		type ArtifactPanelSnapshot,
		type ArtifactRevision
	} from '$lib/chat/artifacts';
	import ProjectPicker, { type ProjectSelection } from '$lib/components/home/project-picker.svelte';
	import ProjectSidebar from '$lib/components/home/project-sidebar.svelte';
	import Button from '$lib/components/ui/button/button.svelte';
	import {
		attachLocalProject as attachLocalProjectForPath,
		createLatestTaskQueue,
		getDesiredAttachedProjectIds,
		isRunBlockingAgentLaunch,
		launchAgentRun,
		refreshDesktopProjectAttachments as refreshDesktopProjectAttachmentsFromDesktop,
		resolveDraftRunSubmissionId,
		resolveSubmissionId,
		verifyProjectAttachment as verifyProjectAttachmentForExecution,
		type ProjectState
	} from '$lib/home/desktop';
	import { formatElapsedDuration } from '$lib/format';
	import { validateImageAttachmentAddition, type ComposerAttachment } from '$lib/chat/attachments';
	import {
		defaultModelId,
		defaultReasoningEffort,
		defaultServiceTier,
		type SupportedReasoningEffort,
		type SupportedServiceTier
	} from '$convex/lib/models';
	import {
		asSupportedModelId,
		getCatalogModel,
		type CatalogModelId
	} from '$lib/chat/model-catalog';
	import { isClaimedRunStatus } from '$convex/lib/runLease';
	import {
		beginPendingAgentLaunch,
		clearPendingAgentLaunch,
		dataForThread,
		findThreadById,
		findProjectById,
		findProjectByRepositoryKey,
		getProjectThreadGroups,
		isActiveThread,
		isAgentLaunchPending,
		isLatestRunReadyForThread,
		resolveExpiredAgentLaunch,
		resolvePendingAgentLaunch,
		resolvePendingAgentLaunchesFromThreads,
		resolvePendingCreatedThreadId,
		resolveProjectThreadSelection,
		shouldForkProjectForRemoteChange,
		type PendingAgentLaunches
	} from '$lib/project/threads';
	import { mergeThreadTranscriptMessages } from '$lib/project/transcript';
	import {
		clearLaunchHash,
		readWorkspaceLaunchFromHash,
		resolveDesktopApi
	} from '$lib/local/client';
	import { resolve } from '$app/paths';
	import { applyTheme, resolveTheme, type SprocketTheme } from '$lib/theme';
	import type {
		DesktopApi,
		ThreadMessage,
		ThreadSummary,
		Project,
		ProjectAttachment,
		ProjectThreadGroup
	} from '$lib/types/sprocket';

	const convexAuth = useAuth();
	let sawAuthLoadingDuringRetry = $state(false);
	const isSignedIn = $derived(Boolean($authState.user));
	const retryPending = $derived($convexAuthRetryPending);
	const authReady = $derived(
		$authState.isReady &&
			!$authState.isLoading &&
			isSignedIn &&
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
	const upsertProject = useMutation(api.projects.upsertSelected);
	const createThreadMutation = useMutation(api.threads.create);
	const renameThreadMutation = useMutation(api.threads.rename);
	const archiveThreadMutation = useMutation(api.threads.archive);
	const restoreThreadMutation = useMutation(api.threads.restore);
	const finalizeRun = useMutation(api.agentRuntime.finalizeRun);
	const answerAgentQuestion = useMutation(api.agentQuestions.answer);
	const setLastThread = useMutation(api.uiPreferences.setLastThread);
	const setThemePreference = useMutation(api.uiPreferences.setTheme);
	const generateImageUploadUrl = useMutation(api.imageUploads.generateUploadUrl);
	const registerImageUpload = useMutation(api.imageUploads.register);
	const discardImageUpload = useMutation(api.imageUploads.discard);
	const heartbeatAttached = useMutation(api.projects.heartbeatAttached);
	const ensureMySubscription = useMutation(api.billing.ensureMySubscription);
	const modelCatalogQuery = useQuery(api.modelCatalog.get, () => ({}));
	const modelCatalog = $derived(modelCatalogQuery.data);
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
		imageUploadIds?: Id<'imageUploads'>[];
		reasoningEffort?: SupportedReasoningEffort;
		serviceTier?: SupportedServiceTier;
		selectedModel?: CatalogModelId;
		submissionId?: string;
	};
	const projectAttachmentHeartbeatQueue = createLatestTaskQueue(
		async (request: { clientId: string; projectIds: Id<'projects'>[] }) => {
			await heartbeatAttached({
				clientId: request.clientId,
				projectIds: request.projectIds
			});
		}
	);

	let desktopApi = $state<DesktopApi | null>(null);
	let desktopApiResolved = $state(false);
	let currentRepositoryKey = $state<string | null>(null);
	let currentThreadId = $state<Id<'threadRecords'> | null>(null);
	let draftRepositoryKey = $state<string | null>(null);
	// Seed from compiled defaults; composer effects adopt live catalog defaults once loaded.
	let selectedModel = $state<CatalogModelId>(defaultModelId);
	let selectedReasoningEffort = $state<SupportedReasoningEffort>(defaultReasoningEffort);
	let selectedServiceTier = $state<SupportedServiceTier>(defaultServiceTier);
	let prompt = $state('');
	let selectedQuestionOptionId = $state<string | null>(null);
	let answeringAgentQuestion = $state(false);
	let composerAttachments = $state<ComposerAttachment[]>([]);
	let currentError = $state<string | null>(null);
	let executorClientId = $state<string | null>(null);
	let elapsedSeconds = $state(0);
	const submittingPromptScopes = new SvelteMap<string, number>();
	const composerRecoveries = new SvelteMap<string, ComposerRecovery>();
	const recoveredSubmissionIds = new SvelteMap<
		string,
		{
			prompt: string;
			imageUploadIds: Id<'imageUploads'>[];
			reasoningEffort: SupportedReasoningEffort;
			serviceTier: SupportedServiceTier;
			selectedModel: CatalogModelId;
			submissionId: string;
		}
	>();
	const latestSubmissionSequencesByRecoveryScope = new SvelteMap<string, number>();
	const recoveredStaleClaims = new SvelteSet<string>();
	let pendingAgentLaunches = $state<PendingAgentLaunches>({});
	let leaseClockNow = $state(0);
	let latestRunServerClock = $state<{
		localObservedAt: number;
		runId: Id<'runs'> | null;
		serverNow: number;
	} | null>(null);
	let nextAgentLaunchId = 0;
	let nextSubmissionSequence = 0;
	let hasResolvedInitialSelection = $state(false);
	let restoredProjectIdToAttach = $state<Id<'projects'> | null>(null);
	let lastSavedThreadId = $state<Id<'threadRecords'> | null>(null);
	let lastSyncedComposerThreadId: Id<'threadRecords'> | null = null;
	let projectSelectionGeneration = $state(0);
	let pendingCreatedThreadId = $state<Id<'threadRecords'> | null>(null);
	let desktopProjectAttachmentsById = $state<Record<string, ProjectAttachment>>({});
	let hasLoadedDesktopProjectAttachments = $state(false);
	let desktopProjectAttachmentsGeneration = 0;
	let selectionUserId = $state<string | null>(null);
	let projectPickerOpen = $state(false);
	let projectPickerMode = $state<'add' | 'reconnect'>('add');
	let projectPickerExpectedDisplayName = $state<string | undefined>(undefined);
	let projectPickerReconnectProjectId = $state<Id<'projects'> | null>(null);
	let settingsOpen = $state(false);
	let settingsPage = $state<SettingsPage>('account');
	let pendingProjectLaunches = $state<string[]>([]);
	let projectLaunchInFlight = $state(false);
	let initialProjectLaunchResolved = $state(false);
	const remoteChangeNotices = new SvelteMap<Id<'threadRecords'>, string>();
	let artifactFullscreenKey = $state<string | null>(null);
	const REMOTE_CHANGE_NOTICE =
		'A new project was created because this directory’s git remote changed. Earlier threads stay on the previous project.';
	function getCurrentUserId() {
		return $authState.user?.id ?? null;
	}

	function updateComposerAttachment(localId: string, patch: Partial<ComposerAttachment>) {
		const attachment = composerAttachments.find((entry) => entry.localId === localId);
		if (!attachment) {
			return false;
		}
		composerAttachments = composerAttachments.map((entry) =>
			entry.localId === localId ? { ...entry, ...patch } : entry
		);
		return true;
	}

	async function uploadComposerAttachment(localId: string, file: File, name: string) {
		try {
			const uploadUrl = await generateImageUploadUrl({});
			const response = await fetch(uploadUrl, {
				method: 'POST',
				headers: { 'Content-Type': file.type },
				body: file
			});
			if (!response.ok) {
				throw new Error(`Upload failed (${response.status}).`);
			}
			const { storageId } = await response.json();
			const registered = await registerImageUpload({ storageId, name });
			if ('error' in registered) {
				throw new Error(registered.error);
			}
			const attachment = composerAttachments.find((entry) => entry.localId === localId);
			if (attachment) {
				URL.revokeObjectURL(attachment.previewUrl);
			}
			const stillAttached = updateComposerAttachment(localId, {
				status: 'ready',
				imageUploadId: registered.imageUploadId,
				previewUrl: registered.url
			});
			if (!stillAttached) {
				void discardImageUpload({ imageUploadId: registered.imageUploadId }).catch(() => {});
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Upload failed.';
			updateComposerAttachment(localId, {
				status: 'error',
				error: message
			});
			currentError = message;
		}
	}

	function addComposerAttachments(files: File[]) {
		for (const file of files) {
			const validationError = validateImageAttachmentAddition(composerAttachments.length, file);
			if (validationError) {
				currentError = validationError;
				continue;
			}
			const localId = crypto.randomUUID();
			const name = file.name || 'Pasted image';
			composerAttachments = [
				...composerAttachments,
				{
					localId,
					name,
					mediaType: file.type,
					size: file.size,
					previewUrl: URL.createObjectURL(file),
					status: 'uploading'
				}
			];
			void uploadComposerAttachment(localId, file, name);
		}
	}

	function removeComposerAttachment(localId: string) {
		const attachment = composerAttachments.find((entry) => entry.localId === localId);
		if (!attachment) {
			return;
		}
		URL.revokeObjectURL(attachment.previewUrl);
		composerAttachments = composerAttachments.filter((entry) => entry.localId !== localId);
		if (attachment.imageUploadId) {
			void discardImageUpload({ imageUploadId: attachment.imageUploadId }).catch(() => {});
		}
	}

	function clearComposerAttachments(options: { discard: boolean }) {
		for (const attachment of composerAttachments) {
			URL.revokeObjectURL(attachment.previewUrl);
			if (options.discard && attachment.imageUploadId) {
				void discardImageUpload({ imageUploadId: attachment.imageUploadId }).catch(() => {});
			}
		}
		composerAttachments = [];
	}

	function getComposerScope(
		threadId: Id<'threadRecords'> | null,
		projectId: Id<'projects'> | null
	) {
		return threadId ? `thread:${threadId}` : projectId ? `draft:${projectId}` : null;
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
		return $authState.user && convexAuth.isAuthenticated && !convexAuth.isLoading ? {} : 'skip';
	}

	const projectsQuery = useQuery(api.projects.listMine, getAuthenticatedQueryArgs);
	const threadsQuery = useQuery(api.threads.listMine, getAuthenticatedQueryArgs);
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
	const historyMessagesQuery = useQuery(
		api.messages.listHistoryForThread,
		authenticatedThreadQueryArgs
	);
	const liveMessagesQuery = useQuery(api.messages.listLiveForThread, authenticatedThreadQueryArgs);
	const latestRunQuery = useQuery(api.chat.latestRunForThread, authenticatedThreadQueryArgs);
	const artifactsQuery = useQuery(
		api.artifacts.listArtifactsForThread,
		authenticatedThreadQueryArgs
	);
	const pendingAgentQuestionQuery = useQuery(
		api.agentQuestions.headPendingForThread,
		authenticatedThreadQueryArgs
	);
	const queryError = $derived.by(() => {
		for (const query of [
			modelCatalogQuery,
			projectsQuery,
			threadsQuery,
			uiPreferencesQuery,
			activeThreadQuery,
			historyMessagesQuery,
			liveMessagesQuery,
			latestRunQuery,
			pendingAgentQuestionQuery
		]) {
			if (query.error) {
				return query.error;
			}
		}

		return null;
	});
	const projects = $derived.by<ProjectState[]>(() =>
		((projectsQuery.data ?? []) as Project[]).map((project) => {
			const desktopAttachment = desktopProjectAttachmentsById[project._id];
			return {
				...project,
				workspacePath: desktopAttachment?.workspacePath,
				localAttachmentAvailability: desktopAttachment
					? desktopAttachment.availability
					: ('unlinked' as const),
				localAttachmentError: desktopAttachment?.unavailableReason
			};
		})
	);
	const threads = $derived((threadsQuery.data ?? []) as ThreadSummary[]);
	const currentActiveThread = $derived(dataForThread(activeThreadQuery.data, currentThreadId));
	const contextUsage = $derived.by(() => {
		const model = modelCatalog
			? (getCatalogModel(modelCatalog, selectedModel) ??
				getCatalogModel(modelCatalog, modelCatalog.defaultModelId))
			: undefined;
		return {
			inputTokens: currentActiveThread?.contextTokens ?? 0,
			totalTokensProcessed: currentActiveThread ? currentActiveThread.totalTokensProcessed : 0,
			contextWindowTokens: model?.contextWindowTokens ?? 0,
			autoCompactTokenLimit: model?.autoCompactTokenLimit ?? 0
		};
	});
	const currentLatestRunData = $derived(dataForThread(latestRunQuery.data, currentThreadId));
	const pendingAgentQuestion = $derived(
		dataForThread(pendingAgentQuestionQuery.data, currentThreadId)
	);
	const currentHistoryMessagesData = $derived(
		dataForThread(historyMessagesQuery.data, currentThreadId)
	);
	const currentLiveMessagesData = $derived(dataForThread(liveMessagesQuery.data, currentThreadId));
	// Pure derived merge only — no $effect/$state hold. Convex delivers history+live in one
	// client transition; a held-live effect previously infinite-looped and froze all UI updates
	// (messages, run timer, working state) until hard reload.
	const visibleMessages = $derived.by(() => {
		if (!currentHistoryMessagesData || !currentLiveMessagesData) {
			return [] as ThreadMessage[];
		}
		return mergeThreadTranscriptMessages({
			historyMessages: currentHistoryMessagesData.messages as ThreadMessage[],
			liveMessages: currentLiveMessagesData.messages as ThreadMessage[]
		});
	});

	const currentProject = $derived.by<ProjectState | null>(() => {
		if (!currentRepositoryKey) {
			return null;
		}

		return findProjectByRepositoryKey(projects, currentRepositoryKey);
	});

	const currentProjectId = $derived(currentProject?._id ?? null);
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
		if (!currentProjectId) {
			return [];
		}

		return threads
			.filter((thread) => thread.projectId === currentProjectId && isActiveThread(thread))
			.sort((left, right) => right.lastMessageAt - left.lastMessageAt);
	});

	const groupedProjectThreads = $derived.by<ProjectThreadGroup[]>(() =>
		getProjectThreadGroups(projects, threads)
	);

	const runState = $derived(currentLatestRunData?.run ?? null);
	const visibleActions = $derived((currentLatestRunData?.jobs ?? []).slice(-60));
	const threadArtifacts = $derived(
		(artifactsQuery.data ?? []).map((entry) => ({
			key: entry.artifact._id as string,
			title: entry.artifact.title,
			artifactType: entry.artifact.type,
			content: entry.currentContent
		}))
	);
	// Panel state snapshots survive thread switches; the live thread always has
	// an entry after the restore effect below runs.
	const artifactSnapshots = new SvelteMap<Id<'threadRecords'>, ArtifactPanelSnapshot>();
	let artifactPanel = $state<ArtifactPanelSnapshot>({ ...DEFAULT_ARTIFACT_PANEL_SNAPSHOT });
	let artifactPanelThreadId: Id<'threadRecords'> | null = null;
	// Baseline for create/update detection; null means the next observation only seeds.
	let artifactRevisionWatch: {
		threadId: Id<'threadRecords'>;
		revisions: Map<string, ArtifactRevision>;
	} | null = null;

	$effect(() => {
		const threadId = currentThreadId;
		if (threadId === artifactPanelThreadId) return;
		if (artifactPanelThreadId) {
			artifactSnapshots.set(artifactPanelThreadId, artifactPanel);
		}
		artifactPanelThreadId = threadId;
		artifactFullscreenKey = null;
		artifactPanel = {
			...((threadId && artifactSnapshots.get(threadId)) || DEFAULT_ARTIFACT_PANEL_SNAPSHOT)
		};
	});

	$effect(() => {
		const threadId = currentThreadId;
		const data = artifactsQuery.data;
		if (!threadId) {
			artifactRevisionWatch = null;
			return;
		}
		// Drop the prior thread's baseline immediately on switch, even while loading,
		// so A→B(loading)→A re-seeds instead of treating away-updates as live changes.
		if (artifactRevisionWatch && artifactRevisionWatch.threadId !== threadId) {
			artifactRevisionWatch = null;
		}
		if (data === undefined) return;

		const current: ArtifactRevision[] = data.map((entry) => ({
			id: entry.artifact._id as string,
			currentVersion: entry.artifact.currentVersion,
			updatedAt: entry.artifact.updatedAt
		}));
		const previous = artifactRevisionWatch?.revisions ?? null;
		const { revisions, changedId } = nextArtifactRevisionWatch(previous, current);
		artifactRevisionWatch = { threadId, revisions };

		if (!changedId) return;
		// Avoid depending on panel UI state for re-runs; only follow selection when
		// opening or when the user is still on the list view.
		const prior = untrack(() => artifactPanel);
		artifactPanel = {
			...prior,
			open: true,
			selectedKey: !prior.open || prior.selectedKey === null ? changedId : prior.selectedKey
		};
	});

	const fullscreenArtifact = $derived(
		threadArtifacts.find((artifact) => artifact.key === artifactFullscreenKey) ?? null
	);
	const currentComposerScope = $derived(getComposerScope(currentThreadId, currentProjectId));
	const estimatedServerNow = $derived(
		latestRunServerClock && latestRunServerClock.runId === (runState?._id ?? null)
			? latestRunServerClock.serverNow +
					Math.max(0, leaseClockNow - latestRunServerClock.localObservedAt)
			: (currentLatestRunData?.serverNow ?? Date.now())
	);
	const currentRecoveredSubmission = $derived.by(() => {
		const userId = getCurrentUserId();
		if (!userId || !currentComposerScope) return undefined;
		return recoveredSubmissionIds.get(getComposerRecoveryKey(userId, currentComposerScope));
	});
	const isRetryableQueuedRun = $derived(
		runState?.status === 'queued' &&
			currentRecoveredSubmission?.submissionId === runState.submissionId
	);
	const isRunning = $derived(
		isRunBlockingAgentLaunch(runState, estimatedServerNow) && !isRetryableQueuedRun
	);
	const hasPendingAgentLaunch = $derived(
		isAgentLaunchPending(pendingAgentLaunches, currentThreadId)
	);
	const isLatestRunReady = $derived(
		isLatestRunReadyForThread({
			threadId: currentThreadId,
			pendingCreatedThreadId,
			hasLatestRunData: Boolean(currentLatestRunData)
		})
	);
	const isSubmittingPrompt = $derived(
		Boolean(currentComposerScope && submittingPromptScopes.has(currentComposerScope))
	);
	const canSend = $derived(
		Boolean(
			currentProjectId &&
			currentProject?.localAttachmentAvailability === 'available' &&
			!isSubmittingPrompt &&
			!answeringAgentQuestion &&
			!hasPendingAgentLaunch &&
			((!isRunning && isLatestRunReady) || pendingAgentQuestion)
		)
	);
	const desiredAttachedProjectIds = $derived.by<Id<'projects'>[]>(() =>
		getDesiredAttachedProjectIds(
			Object.values(desktopProjectAttachmentsById),
			projects.map((project) => project._id)
		)
	);
	const desiredAttachedProjectIdsKey = $derived.by(() =>
		[...desiredAttachedProjectIds].sort().join('\0')
	);
	const recentProjectDirectories = $derived.by(() => {
		const seen = new SvelteSet<string>();
		const recents: Array<{ workspacePath: string; displayName: string }> = [];

		for (const attachment of Object.values(desktopProjectAttachmentsById)) {
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

		desktopProjectAttachmentsById = nextAttachments;
		hasLoadedDesktopProjectAttachments = true;
	}

	function applyProjectSelection(
		repositoryKey: string,
		threadId: Id<'threadRecords'> | null = null,
		draft: boolean = false
	) {
		currentRepositoryKey = repositoryKey;
		currentThreadId = threadId;
		draftRepositoryKey = draft ? repositoryKey : null;
		if (threadId !== pendingCreatedThreadId) {
			pendingCreatedThreadId = null;
		}
	}

	function setProjectSelection(
		repositoryKey: string,
		threadId: Id<'threadRecords'> | null = null,
		draft: boolean = false,
		preserveError: boolean = false
	) {
		projectSelectionGeneration += 1;
		if (!preserveError) {
			currentError = null;
		}
		applyProjectSelection(repositoryKey, threadId, draft);
	}

	async function attachLocalProject(projectId: Id<'projects'>, workspacePath: string) {
		if (!desktopApi) {
			throw new Error(localServerRequiredMessage);
		}

		const attachment = await attachLocalProjectForPath({
			desktopApi,
			projectId,
			workspacePath
		});
		desktopProjectAttachmentsGeneration += 1;
		desktopProjectAttachmentsById = {
			...desktopProjectAttachmentsById,
			[attachment.projectId]: attachment
		};
		hasLoadedDesktopProjectAttachments = true;
		return attachment;
	}

	function openProject(
		repositoryKey: string,
		selection: { threadId?: Id<'threadRecords'> | null; draft?: boolean } = {}
	) {
		const project = findProjectByRepositoryKey(projects, repositoryKey);
		if (!project) {
			currentError = 'Choose a project first.';
			return;
		}

		setProjectSelection(repositoryKey, selection.threadId, selection.draft);
		const selectionGeneration = projectSelectionGeneration;
		void verifyProject(project._id).catch((error) => {
			if (selectionGeneration === projectSelectionGeneration) {
				currentError = error instanceof Error ? error.message : 'Failed to attach project.';
			}
		});
	}

	function openProjectPicker(
		mode: 'add' | 'reconnect' = 'add',
		projectId: Id<'projects'> | null = null
	) {
		if (!desktopApi || !executorClientId) {
			currentError = localServerRequiredMessage;
			return;
		}

		projectPickerMode = mode;
		projectPickerReconnectProjectId = projectId;
		const reconnectProject =
			mode === 'reconnect' && projectId
				? projects.find((project) => project._id === projectId)
				: undefined;
		projectPickerExpectedDisplayName = reconnectProject?.displayName;
		projectPickerOpen = true;
		currentError = null;
	}

	async function handleProjectSelected(selection: ProjectSelection) {
		if (!desktopApi || !executorClientId) {
			currentError = localServerRequiredMessage;
			return;
		}
		const pickerUserId = getCurrentUserId();
		const pickerClientId = executorClientId;
		if (!pickerUserId) {
			currentError = 'User session is not ready.';
			return;
		}

		try {
			if (projectPickerMode === 'reconnect' && projectPickerReconnectProjectId) {
				await reconnectProjectSelection(
					selection,
					projectPickerReconnectProjectId,
					pickerUserId,
					pickerClientId
				);
				return;
			}

			await addProjectSelection(selection, pickerUserId, pickerClientId);
		} catch (error) {
			if (getCurrentUserId() !== pickerUserId) {
				return;
			}
			currentError = error instanceof Error ? error.message : 'Failed to attach project.';
			throw error;
		}
	}

	async function upsertCloudProject(selection: ProjectSelection, connectedClientId: string) {
		const project = await upsertProject({
			repositoryKey: selection.repositoryKey,
			displayName: selection.displayName,
			connectedClientId
		});
		if (!project) {
			throw new Error('Failed to create or update the project.');
		}
		return project;
	}

	async function addProjectSelection(
		selection: ProjectSelection,
		expectedUserId: string,
		connectedClientId: string
	) {
		const project = await upsertCloudProject(selection, connectedClientId);
		if (getCurrentUserId() !== expectedUserId) {
			return;
		}

		await attachLocalProject(project._id, selection.workspacePath);
		if (getCurrentUserId() !== expectedUserId) {
			return;
		}
		setProjectSelection(selection.repositoryKey, null, true);
		currentError = null;
	}

	async function reconnectProjectSelection(
		selection: ProjectSelection,
		reconnectProjectId: Id<'projects'>,
		expectedUserId: string,
		connectedClientId: string
	) {
		const previousProject = projects.find((project) => project._id === reconnectProjectId);
		const project = await upsertCloudProject(selection, connectedClientId);
		if (getCurrentUserId() !== expectedUserId) {
			return;
		}

		await attachLocalProject(project._id, selection.workspacePath);
		if (getCurrentUserId() !== expectedUserId) {
			return;
		}
		const keepThread =
			previousProject?.repositoryKey === selection.repositoryKey ? currentThreadId : null;
		setProjectSelection(selection.repositoryKey, keepThread);
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

	async function openLaunchedProject(
		workspacePath: string,
		client: DesktopApi,
		userId: string,
		clientId: string
	) {
		const selection = await client.resolveWorkspacePath({ workspacePath });
		if (getCurrentUserId() !== userId) {
			return;
		}
		await addProjectSelection(selection, userId, clientId);
	}

	async function verifyProject(projectId: Id<'projects'>) {
		await verifyProjectAttachmentForExecution({
			desktopApi,
			refreshDesktopProjectAttachments,
			projectId
		});
	}

	function reconnectProject(projectId: Id<'projects'>) {
		openProjectPicker('reconnect', projectId);
	}

	function schedulePendingCreatedThreadExpiration(args: {
		prompt: string;
		attachments: ComposerAttachment[];
		imageUploadIds: Id<'imageUploads'>[];
		reasoningEffort: SupportedReasoningEffort;
		serviceTier: SupportedServiceTier;
		selectedModel: CatalogModelId;
		submissionId: string;
		threadId: Id<'threadRecords'>;
		userId: string;
		repositoryKey: string;
		projectId: Id<'projects'>;
	}) {
		window.setTimeout(() => {
			if (
				getCurrentUserId() !== args.userId ||
				pendingCreatedThreadId !== args.threadId ||
				currentThreadId !== args.threadId ||
				currentRepositoryKey !== args.repositoryKey ||
				threads.some((thread) => thread.threadId === args.threadId)
			) {
				return;
			}

			pendingCreatedThreadId = null;
			setProjectSelection(args.repositoryKey, null, true);
			const recoveryScope = getComposerScope(null, args.projectId);
			if (recoveryScope) {
				storeComposerRecovery(args.userId, recoveryScope, {
					message: 'The new thread did not appear. Review your prompt and try sending it again.',
					prompt: args.prompt,
					attachments: args.attachments,
					imageUploadIds: args.imageUploadIds,
					reasoningEffort: args.reasoningEffort,
					serviceTier: args.serviceTier,
					selectedModel: args.selectedModel,
					submissionId: args.submissionId
				});
			}
		}, agentLaunchTimeoutMs);
	}

	async function createThread(args: {
		isSubmissionCurrent: () => boolean;
		prompt: string;
		attachments: ComposerAttachment[];
		imageUploadIds: Id<'imageUploads'>[];
		selectionGeneration: number;
		selectedModel: CatalogModelId;
		selectedReasoningEffort: SupportedReasoningEffort;
		selectedServiceTier: SupportedServiceTier;
		submissionId: string;
		userId: string;
		repositoryKey: string;
		projectId: Id<'projects'>;
	}) {
		const result = await createThreadMutation({
			submissionId: args.submissionId,
			projectId: args.projectId,
			selectedModel: asSupportedModelId(args.selectedModel),
			reasoningEffort: args.selectedReasoningEffort,
			serviceTier: args.selectedServiceTier
		});
		if (!args.isSubmissionCurrent()) {
			return null;
		}

		if (
			args.userId === getCurrentUserId() &&
			args.selectionGeneration === projectSelectionGeneration
		) {
			pendingCreatedThreadId = result.threadId;
			projectSelectionGeneration += 1;
			currentThreadId = result.threadId;
			draftRepositoryKey = null;
			schedulePendingCreatedThreadExpiration({
				prompt: args.prompt,
				attachments: args.attachments,
				imageUploadIds: args.imageUploadIds,
				reasoningEffort: args.selectedReasoningEffort,
				serviceTier: args.selectedServiceTier,
				selectedModel: args.selectedModel,
				submissionId: args.submissionId,
				threadId: result.threadId,
				userId: args.userId,
				repositoryKey: args.repositoryKey,
				projectId: args.projectId
			});
		}

		return result;
	}

	function startThreadDraftForProject(repositoryKey: string) {
		openProject(repositoryKey, { draft: true });
	}

	function selectThread(thread: ThreadSummary) {
		const project = findProjectById(projects, thread.projectId);
		if (!project) {
			currentError = 'Choose a project first.';
			return;
		}
		openProject(project.repositoryKey, { threadId: thread.threadId });
	}

	async function renameThread(threadId: Id<'threadRecords'>, title: string) {
		try {
			await renameThreadMutation({ threadId, title });
		} catch (error) {
			currentError = error instanceof Error ? error.message : 'Failed to rename thread.';
		}
	}

	async function archiveThread(threadId: Id<'threadRecords'>) {
		const archiveUserId = getCurrentUserId();
		try {
			await archiveThreadMutation({ threadId });
			if (archiveUserId) {
				clearComposerRecovery(archiveUserId, `thread:${threadId}`);
			}
			if (getCurrentUserId() === archiveUserId) {
				if (currentThreadId === threadId) {
					currentThreadId = null;
					pendingCreatedThreadId = null;
					projectSelectionGeneration += 1;
				}
				if (lastSavedThreadId === threadId) {
					lastSavedThreadId = null;
				}
				currentError = null;
			}
		} catch (error) {
			if (getCurrentUserId() !== archiveUserId) {
				return;
			}
			currentError = error instanceof Error ? error.message : 'Failed to archive thread.';
		}
	}

	async function restoreThread(threadId: Id<'threadRecords'>) {
		try {
			await restoreThreadMutation({ threadId });
		} catch (error) {
			currentError = error instanceof Error ? error.message : 'Failed to restore thread.';
		}
	}

	async function submitAgentQuestionAnswer() {
		const question = pendingAgentQuestion;
		const threadId = currentThreadId;
		if (!question || !threadId || answeringAgentQuestion) {
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
		prompt = '';
		selectedQuestionOptionId = null;
		try {
			await answerAgentQuestion({
				threadId,
				questionId: question.questionId,
				...(submittedOptionId ? { optionId: submittedOptionId } : {}),
				...(answerText ? { text: answerText } : {})
			});
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
	}

	async function submitPrompt() {
		if (pendingAgentQuestion) {
			await submitAgentQuestionAnswer();
			return;
		}

		if (isSubmittingPrompt) {
			return;
		}

		if (!prompt.trim() && composerAttachments.length === 0) {
			return;
		}

		if (composerAttachments.some((attachment) => attachment.status !== 'ready')) {
			currentError = 'Wait for image uploads to finish, or remove failed images before sending.';
			return;
		}

		const projectId = currentProjectId;
		if (!projectId) {
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
				isRunning || hasPendingAgentLaunch || isSubmittingPrompt
					? 'Wait for the current agent launch or run to finish.'
					: currentProject?.localAttachmentAvailability === 'available'
						? 'You need an active project before sending.'
						: 'This project needs to be attached before sending.';
			return;
		}

		elapsedSeconds = 0;

		const selectionGeneration = projectSelectionGeneration;
		const selectedThreadId = currentThreadId;
		let submittedRepositoryKey = currentRepositoryKey;
		if (!submittedRepositoryKey) {
			currentError = 'Choose a project first.';
			return;
		}
		let targetProjectId = projectId;
		let forkedForRemoteChange = false;
		const submittedUserId = getCurrentUserId();
		if (!submittedUserId) {
			currentError = 'User session is not ready.';
			return;
		}
		const isSubmittedUserCurrent = () => getCurrentUserId() === submittedUserId;
		const submittedPrompt = prompt.trim();
		const submittedAttachments = composerAttachments.map((attachment) => ({ ...attachment }));
		const submittedImageUploadIds = submittedAttachments.flatMap((attachment) =>
			attachment.imageUploadId ? [attachment.imageUploadId] : []
		);
		const submittedModel = selectedModel;
		const submittedReasoningEffort = selectedReasoningEffort;
		const submittedServiceTier = selectedServiceTier;
		const previousRunId = selectedThreadId ? (runState?._id ?? null) : null;
		let submissionScope = selectedThreadId ? `thread:${selectedThreadId}` : `draft:${projectId}`;
		const originatingRecoveryScope = submissionScope;
		let recoveryScope = originatingRecoveryScope;
		const originatingRecoveryKey = getComposerRecoveryKey(
			submittedUserId,
			originatingRecoveryScope
		);
		const recoveredSubmission = recoveredSubmissionIds.get(originatingRecoveryKey);
		const freshSubmissionId = crypto.randomUUID();
		const threadSubmissionId = resolveSubmissionId({
			latestRun: selectedThreadId ? runState : null,
			newSubmissionId: freshSubmissionId,
			prompt: submittedPrompt,
			imageUploadIds: submittedImageUploadIds,
			reasoningEffort: submittedReasoningEffort,
			serviceTier: submittedServiceTier,
			recoveredSubmission: recoveredSubmission
				? {
						...recoveredSubmission,
						selectedModel: asSupportedModelId(recoveredSubmission.selectedModel)
					}
				: undefined,
			selectedModel: asSupportedModelId(submittedModel)
		});
		let runSubmissionId = threadSubmissionId;
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
				imageUploadIds: submittedImageUploadIds,
				reasoningEffort: submittedReasoningEffort,
				serviceTier: submittedServiceTier,
				selectedModel: submittedModel,
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

			storeComposerRecovery(submittedUserId, recoveryScope, {
				message: submissionDelayMessage,
				prompt: ''
			});
		}, agentLaunchTimeoutMs);
		prompt = '';
		currentError = null;
		submittingPromptScopes.set(submissionScope, submissionSequence);

		try {
			if (!selectedThreadId) {
				const workspacePath = currentProject?.workspacePath;
				if (!workspacePath) {
					throw new Error('This project needs to be attached before sending.');
				}
				const resolution = await desktopApi.resolveWorkspacePath({ workspacePath });
				if (!isSubmissionCurrent()) {
					return;
				}
				if (shouldForkProjectForRemoteChange(submittedRepositoryKey, resolution.repositoryKey)) {
					if (!executorClientId) {
						throw new Error(localServerRequiredMessage);
					}
					const forkedProject = await upsertCloudProject(
						{
							workspacePath: resolution.workspacePath,
							displayName: resolution.displayName,
							repositoryKey: resolution.repositoryKey
						},
						executorClientId
					);
					if (!isSubmissionCurrent()) {
						return;
					}
					await attachLocalProject(forkedProject._id, resolution.workspacePath);
					if (!isSubmissionCurrent()) {
						return;
					}
					targetProjectId = forkedProject._id;
					submittedRepositoryKey = resolution.repositoryKey;
					forkedForRemoteChange = true;
					clearSubmittingPrompt(submissionScope, submissionSequence);
					submissionScope = `draft:${targetProjectId}`;
					submittingPromptScopes.set(submissionScope, submissionSequence);
				}
			}

			const threadCreation = selectedThreadId
				? null
				: await createThread({
						isSubmissionCurrent,
						prompt: submittedPrompt,
						attachments: submittedAttachments,
						imageUploadIds: submittedImageUploadIds,
						selectionGeneration,
						selectedModel: submittedModel,
						selectedReasoningEffort: submittedReasoningEffort,
						selectedServiceTier: submittedServiceTier,
						submissionId: threadSubmissionId,
						userId: submittedUserId,
						repositoryKey: submittedRepositoryKey,
						projectId: targetProjectId
					});
			const threadId = selectedThreadId ?? threadCreation?.threadId ?? null;
			if (!threadId || !isSubmissionCurrent()) {
				return;
			}
			if (threadCreation) {
				runSubmissionId = resolveDraftRunSubmissionId({
					freshSubmissionId,
					submissionRunStatus: threadCreation.submissionRunStatus,
					threadSubmissionId
				});
			}
			if (!isSubmittedUserCurrent()) {
				recoverSubmission(sessionChangedMessage);
				return;
			}
			launchedThreadId = threadId;
			if (!selectedThreadId) {
				clearSubmittingPrompt(submissionScope, submissionSequence);
				submissionScope = `thread:${threadId}`;
				submittingPromptScopes.set(submissionScope, submissionSequence);
				clearSubmissionDelay();
				if (
					latestSubmissionSequencesByRecoveryScope.get(submissionTrackingKey) === submissionSequence
				) {
					latestSubmissionSequencesByRecoveryScope.delete(submissionTrackingKey);
				}
				recoveryScope = `thread:${threadId}`;
				submissionTrackingKey = getComposerRecoveryKey(submittedUserId, recoveryScope);
				latestSubmissionSequencesByRecoveryScope.set(submissionTrackingKey, submissionSequence);
				if (forkedForRemoteChange) {
					setProjectSelection(submittedRepositoryKey, threadId);
					remoteChangeNotices.set(threadId, REMOTE_CHANGE_NOTICE);
				}
			}
			// The browser is no longer involved after Convex binds the run-scoped
			// executor capability. Start with a fresh token so closing the tab during
			// the detached launch cannot strand it on an expiring browser token.
			const authToken = await getAccessToken({ forceRefreshToken: true });
			if (!authToken) {
				recoverSubmission('Your session ended before the agent started. Sign in again.');
				return;
			}
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
			pendingAgentLaunches = beginPendingAgentLaunch(pendingAgentLaunches, threadId, {
				expiresAt: Date.now() + agentLaunchTimeoutMs,
				launchId,
				...(runState?.claimExpiresAt ? { previousClaimExpiresAt: runState.claimExpiresAt } : {}),
				previousRunId
			});
			window.setTimeout(() => {
				const threadLatestRunId =
					threads.find((thread) => thread.threadId === threadId)?.latestRunId ?? null;
				const selectedRunId = currentThreadId === threadId ? (runState?._id ?? null) : null;
				const latestRunId =
					[threadLatestRunId, selectedRunId].find((runId) => runId && runId !== previousRunId) ??
					threadLatestRunId ??
					selectedRunId;
				const latestClaimExpiresAt =
					currentThreadId === threadId && runState?._id === latestRunId
						? runState.claimExpiresAt
						: threads.find((thread) => thread.threadId === threadId)?.latestRunClaimExpiresAt;
				const recovery = resolveExpiredAgentLaunch(
					pendingAgentLaunches,
					threadId,
					launchId,
					Date.now(),
					latestRunId,
					latestClaimExpiresAt
				);
				if (recovery.pendingLaunches === pendingAgentLaunches) {
					return;
				}

				pendingAgentLaunches = recovery.pendingLaunches;
				if (recovery.shouldRecover) {
					recoverSubmission('The local agent did not start. Please try again.');
				}
			}, agentLaunchTimeoutMs);
			launchAgentRun({
				authToken,
				desktopApi,
				onError: (error) => {
					if (!isSubmissionCurrent() || !isSubmittedUserCurrent()) {
						return;
					}
					const nextPendingAgentLaunches = clearPendingAgentLaunch(
						pendingAgentLaunches,
						threadId,
						launchId
					);
					if (nextPendingAgentLaunches !== pendingAgentLaunches) {
						pendingAgentLaunches = nextPendingAgentLaunches;
					}
					recoverSubmission(
						error instanceof Error ? error.message : 'Failed to start the local agent run.'
					);
				},
				onStarted: (runId) => {
					if (!isSubmissionCurrent() || !isSubmittedUserCurrent()) return;
					pendingAgentLaunches = resolvePendingAgentLaunch(pendingAgentLaunches, threadId, runId);
					clearComposerAttachments({ discard: false });
				},
				threadId,
				prompt: submittedPrompt,
				imageUploadIds: submittedImageUploadIds,
				selectedModel: asSupportedModelId(submittedModel),
				submissionId: runSubmissionId,
				reasoningEffort: submittedReasoningEffort,
				serviceTier: submittedServiceTier,
				projectId: targetProjectId
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
		if (!runState?._id || !isRunning) {
			return;
		}

		try {
			await finalizeRun({
				runId: runState._id,
				text: '',
				status: 'cancelled'
			});
		} catch (error) {
			currentError = error instanceof Error ? error.message : 'Failed to cancel run.';
		}
	}

	$effect(() => {
		const data = currentLatestRunData;
		if (!data) {
			latestRunServerClock = null;
			return;
		}
		if (
			latestRunServerClock?.serverNow === data.serverNow &&
			latestRunServerClock.runId === (data.run?._id ?? null)
		) {
			return;
		}
		latestRunServerClock = {
			localObservedAt: window.performance.now(),
			runId: data.run?._id ?? null,
			serverNow: data.serverNow
		};
	});

	$effect(() => {
		if (!runState || !isClaimedRunStatus(runState.status)) {
			return;
		}
		const updateClock = () => {
			leaseClockNow = window.performance.now();
		};
		updateClock();
		const intervalId = window.setInterval(updateClock, 1_000);
		return () => window.clearInterval(intervalId);
	});

	$effect(() => {
		const userId = getCurrentUserId();
		const recoveryScope = getComposerScope(currentThreadId, currentProjectId);
		const staleRun = runState;
		if (
			!userId ||
			!recoveryScope ||
			!staleRun ||
			!isClaimedRunStatus(staleRun.status) ||
			isRunning ||
			isSubmittingPrompt ||
			hasPendingAgentLaunch ||
			prompt !== '' ||
			composerAttachments.length > 0 ||
			!currentLatestRunData ||
			(!currentLatestRunData.prompt && !currentLatestRunData.imageUploadIds?.length)
		) {
			return;
		}
		const staleImageUploadIds = currentLatestRunData.imageUploadIds ?? [];
		const stalePrompt = currentLatestRunData.prompt ?? '';
		const stalePromptMessage = visibleMessages.find(
			(message) => message.runId === staleRun._id && message.type === 'prompt'
		);
		const staleAttachments = staleImageUploadIds.flatMap((imageUploadId) => {
			const attachment = stalePromptMessage?.attachments.find(
				(candidate) => candidate.imageUploadId === imageUploadId
			);
			return attachment?.url ? [attachment] : [];
		});
		const missingAttachmentCount = staleImageUploadIds.length - staleAttachments.length;

		const staleClaimKey = `${userId}\0${staleRun._id}\0${staleRun.claimExpiresAt ?? 'none'}`;
		if (recoveredStaleClaims.has(staleClaimKey)) {
			return;
		}
		recoveredStaleClaims.add(staleClaimKey);
		const recoveredAttachments: ComposerAttachment[] = staleAttachments.map((attachment) => ({
			localId: attachment.imageUploadId,
			name: attachment.name,
			mediaType: attachment.mediaType,
			size: attachment.size,
			previewUrl: attachment.url!,
			status: 'ready',
			imageUploadId: attachment.imageUploadId
		}));
		storeComposerRecovery(userId, recoveryScope, {
			message:
				missingAttachmentCount > 0
					? `The previous agent stopped responding. ${missingAttachmentCount} image attachment${missingAttachmentCount === 1 ? ' is' : 's are'} unavailable; review and retry this submission.`
					: 'The previous agent stopped responding. Retry to continue this submission.',
			prompt: stalePrompt,
			attachments: recoveredAttachments,
			imageUploadIds: staleImageUploadIds,
			reasoningEffort: staleRun.reasoningEffort,
			serviceTier: staleRun.serviceTier,
			selectedModel: staleRun.selectedModel,
			submissionId: staleRun.submissionId
		});
	});

	$effect(() => {
		const userId = getCurrentUserId();
		if (selectionUserId === userId) {
			return;
		}

		selectionUserId = userId;
		hasResolvedInitialSelection = false;
		currentRepositoryKey = null;
		currentThreadId = null;
		draftRepositoryKey = null;
		pendingCreatedThreadId = null;
		pendingAgentLaunches = {};
		restoredProjectIdToAttach = null;
		lastSavedThreadId = null;
		ensureSubscriptionAttemptedFor = null;
		lastSyncedComposerThreadId = null;
		projectSelectionGeneration += 1;
		prompt = '';
		clearComposerAttachments({ discard: true });
		currentError = null;
		elapsedSeconds = 0;
		selectedModel = modelCatalog?.defaultModelId ?? defaultModelId;
		selectedReasoningEffort = modelCatalog?.defaultReasoningEffort ?? defaultReasoningEffort;
		selectedServiceTier = modelCatalog?.defaultServiceTier ?? defaultServiceTier;
		projectPickerOpen = false;
		projectPickerReconnectProjectId = null;
		projectPickerExpectedDisplayName = undefined;
	});

	$effect(() => {
		const workspacePath = pendingProjectLaunches[0];
		const client = desktopApi;
		const userId = getCurrentUserId();
		const clientId = executorClientId;
		if (
			!workspacePath ||
			projectLaunchInFlight ||
			!authReady ||
			!client ||
			!userId ||
			!clientId ||
			projectsQuery.data === undefined
		) {
			return;
		}

		pendingProjectLaunches = pendingProjectLaunches.slice(1);
		projectLaunchInFlight = true;
		hasResolvedInitialSelection = true;
		restoredProjectIdToAttach = null;
		projectPickerOpen = false;
		settingsOpen = false;
		currentError = null;
		void openLaunchedProject(workspacePath, client, userId, clientId)
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
		if (!thread) return;
		selectedModel = thread.selectedModel;
		selectedReasoningEffort = thread.reasoningEffort;
		selectedServiceTier = thread.serviceTier;
	});

	$effect(() => {
		const userId = getCurrentUserId();
		const recoveryScope = getComposerScope(currentThreadId, currentProjectId);
		if (!userId || !recoveryScope) {
			return;
		}

		const recoveryKey = getComposerRecoveryKey(userId, recoveryScope);
		const recovery = composerRecoveries.get(recoveryKey);
		if (!recovery) {
			return;
		}

		composerRecoveries.delete(recoveryKey);
		const canRestorePrompt = prompt === '';
		if (canRestorePrompt) {
			prompt = recovery.prompt;
		}
		if (
			composerAttachments.length === 0 &&
			recovery.attachments?.length &&
			(canRestorePrompt || prompt === recovery.prompt)
		) {
			composerAttachments = recovery.attachments.map((attachment) => ({ ...attachment }));
		}
		if (prompt === recovery.prompt) {
			if (
				recovery.submissionId &&
				(recovery.prompt || recovery.imageUploadIds?.length) &&
				recovery.reasoningEffort &&
				recovery.selectedModel
			) {
				recoveredSubmissionIds.set(recoveryKey, {
					prompt: recovery.prompt,
					imageUploadIds: recovery.imageUploadIds ?? [],
					reasoningEffort: recovery.reasoningEffort,
					serviceTier:
						recovery.serviceTier ?? modelCatalog?.defaultServiceTier ?? defaultServiceTier,
					selectedModel: recovery.selectedModel,
					submissionId: recovery.submissionId
				});
			}
		}

		currentError = recovery.message;
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
		const uiPreferences = uiPreferencesQuery.data;
		if (
			hasResolvedInitialSelection ||
			!initialProjectLaunchResolved ||
			pendingProjectLaunches.length > 0 ||
			projectLaunchInFlight
		) {
			return;
		}

		if (!projectsQuery.data || !threadsQuery.data || uiPreferences === undefined) {
			return;
		}

		hasResolvedInitialSelection = true;
		const restoredThread = findThreadById(threads, uiPreferences?.lastThreadId ?? null);
		if (restoredThread && isActiveThread(restoredThread)) {
			const restoredProject = findProjectById(projects, restoredThread.projectId);
			if (restoredProject) {
				setProjectSelection(restoredProject.repositoryKey, restoredThread.threadId, false, true);
				restoredProjectIdToAttach = restoredProject._id;
				lastSavedThreadId = restoredThread.threadId;
				return;
			}
		}

		if (projects[0]) {
			setProjectSelection(projects[0].repositoryKey, null, false, true);
			restoredProjectIdToAttach = projects[0]._id;
		}
	});

	$effect(() => {
		const projectId = restoredProjectIdToAttach;
		if (!projectId || !desktopApi || !hasLoadedDesktopProjectAttachments) {
			return;
		}

		const project = projects.find((candidate) => candidate._id === projectId);
		if (!project) {
			restoredProjectIdToAttach = null;
			return;
		}

		restoredProjectIdToAttach = null;
		const selectionGeneration = projectSelectionGeneration;
		void verifyProject(projectId).catch((error) => {
			if (selectionGeneration === projectSelectionGeneration) {
				currentError = error instanceof Error ? error.message : 'Failed to attach project.';
			}
		});
	});

	$effect(() => {
		const activeThreadSummary = currentThreadId ? findThreadById(threads, currentThreadId) : null;
		const threadProject = findProjectById(projects, activeThreadSummary?.projectId);
		if (threadProject && threadProject.repositoryKey !== currentRepositoryKey) {
			setProjectSelection(
				threadProject.repositoryKey,
				currentThreadId,
				draftRepositoryKey === threadProject.repositoryKey
			);
		}
	});

	$effect(() => {
		const threads = currentProjectThreads;
		if (!hasResolvedInitialSelection || !currentRepositoryKey) {
			return;
		}

		const nextThreadId = resolveProjectThreadSelection({
			threads,
			currentThreadId,
			currentRepositoryKey,
			draftRepositoryKey,
			pendingCreatedThreadId
		});
		if (nextThreadId === currentThreadId) {
			return;
		}

		setProjectSelection(
			currentRepositoryKey,
			nextThreadId,
			draftRepositoryKey === currentRepositoryKey,
			true
		);
	});

	$effect(() => {
		if (!hasResolvedInitialSelection || !currentThreadId) {
			return;
		}

		if (currentThreadId === lastSavedThreadId) {
			return;
		}

		lastSavedThreadId = currentThreadId;
		void setLastThread({ threadId: currentThreadId });
	});

	$effect(() => {
		let nextPendingAgentLaunches = resolvePendingAgentLaunchesFromThreads(
			pendingAgentLaunches,
			threads
		);
		if (currentThreadId && runState?._id) {
			nextPendingAgentLaunches = resolvePendingAgentLaunch(
				nextPendingAgentLaunches,
				currentThreadId,
				runState._id,
				runState.claimExpiresAt
			);
		}
		if (nextPendingAgentLaunches !== pendingAgentLaunches) {
			pendingAgentLaunches = nextPendingAgentLaunches;
		}
	});

	$effect(() => {
		const startedAt = runState?.startedAt;
		if (!isRunning || !startedAt) {
			elapsedSeconds = 0;
			return;
		}

		const updateElapsed = () => {
			elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
		};

		updateElapsed();
		const intervalId = window.setInterval(updateElapsed, 1000);

		return () => {
			window.clearInterval(intervalId);
		};
	});

	$effect(() => {
		const clientId = executorClientId;
		const projectIdsKey = desiredAttachedProjectIdsKey;
		if (
			!clientId ||
			!desktopApi ||
			!hasLoadedDesktopProjectAttachments ||
			projectsQuery.data === undefined ||
			getAuthenticatedQueryArgs() === 'skip'
		) {
			return;
		}
		const request = {
			clientId,
			projectIds: projectIdsKey ? (projectIdsKey.split('\0') as Id<'projects'>[]) : []
		};

		void projectAttachmentHeartbeatQueue.enqueue(request).catch(() => {});

		const intervalId = window.setInterval(() => {
			void projectAttachmentHeartbeatQueue.enqueue(request).catch(() => {});
		}, EXECUTOR_HEARTBEAT_WRITE_THROTTLE_MS);

		return () => {
			window.clearInterval(intervalId);
			projectAttachmentHeartbeatQueue.cancelPending();
		};
	});

	onMount(() => {
		executorClientId = crypto.randomUUID();
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
			.then((client) => {
				desktopApi = client;
				desktopApiResolved = true;
				void refreshDesktopProjectAttachments().catch((error) => {
					currentError =
						error instanceof Error ? error.message : 'Failed to load local project attachments.';
				});
			})
			.catch((error) => {
				currentError =
					error instanceof Error ? error.message : 'Failed to connect to the Sprocket server.';
				desktopApiResolved = true;
			});

		return () => unsubscribeWorkspaceLaunch?.();
	});
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
		description={currentError ?? 'Connect to your Sprocket server to continue.'}
	>
		{#snippet actions()}
			<Button href={resolve('/pair')}>Open pairing</Button>
		{/snippet}
	</CalmCentered>
{:else if !authReady}
	<div class="bg-background h-screen overflow-hidden">
		<AuthGate
			authState={{
				isLoading:
					!$authState.isReady ||
					$authState.isLoading ||
					retryPending ||
					(isSignedIn && convexAuth.isLoading),
				isConfigured: $authState.isConfigured,
				isAuthenticated: isSignedIn,
				connectionFailed: authConnectionFailed,
				error: $authState.error
			}}
			overlayOpen={$authState.isWaitingForBrowserSignIn}
			onSignIn={() => void signIn()}
			onSignOut={() => void signOut()}
			onRetry={() => void retryConvexAuthentication()}
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
			class="app-workspace-shell grid h-screen grid-cols-[292px_minmax(0,1fr)] overflow-hidden {!settingsOpen &&
			artifactPanel.open &&
			!artifactPanel.expanded
				? 'pr-[20rem]'
				: ''}"
			inert={fullscreenArtifact || (artifactPanel.open && artifactPanel.expanded)
				? true
				: undefined}
		>
			{#if settingsOpen}
				<SettingsSidebar
					activePage={settingsPage}
					theme={workspaceTheme}
					onThemeChange={(theme) => void handleThemeChange(theme)}
					onBack={() => {
						settingsOpen = false;
						settingsPage = 'account';
					}}
					onNavigate={(page) => {
						settingsPage = page;
					}}
				/>
			{:else}
				<ProjectSidebar
					{currentRepositoryKey}
					{currentThreadId}
					groups={groupedProjectThreads}
					{pendingAgentLaunches}
					theme={workspaceTheme}
					onThemeChange={(theme) => void handleThemeChange(theme)}
					onAddProject={() => {
						openProjectPicker('add');
					}}
					onReconnectProject={(projectId) => {
						void reconnectProject(projectId);
					}}
					onOpenSettings={() => {
						settingsPage = 'account';
						settingsOpen = true;
					}}
					onStartThreadDraft={startThreadDraftForProject}
					onSelectThread={selectThread}
					onRenameThread={(threadId, title) => {
						void renameThread(threadId, title);
					}}
					onArchiveThread={(threadId) => {
						void archiveThread(threadId);
					}}
				/>
			{/if}

			<main class="relative flex h-screen min-h-0 min-w-0 flex-col overflow-hidden">
				{#if !settingsOpen && !artifactPanel.open}
					<button
						type="button"
						class="text-muted-foreground hover:text-foreground hover:bg-muted absolute top-3 right-3 z-100 inline-flex items-center justify-center rounded-md p-2 transition"
						onclick={() => {
							artifactPanel = { ...artifactPanel, open: true };
						}}
						aria-label="Open artifacts panel"
					>
						<PanelRight class="size-4" aria-hidden="true" />
					</button>
				{/if}
				{#if settingsOpen}
					{#if settingsPage === 'archived'}
						<SettingsArchived
							{threads}
							{projects}
							onRestore={(threadId) => {
								void restoreThread(threadId);
							}}
						/>
					{:else if settingsPage === 'usage'}
						<SettingsUsage />
					{:else if settingsPage === 'payments'}
						<SettingsPayments />
					{:else}
						<SettingsAccount user={$authState.user} onSignOut={() => void signOut()} />
					{/if}
				{:else}
					<ThreadTranscript
						currentError={currentError ?? $authState.error ?? queryError?.message ?? null}
						runError={runState?.lastError ?? null}
						messages={visibleMessages}
						actions={visibleActions}
						activeRunId={isRunning ? (runState?._id ?? null) : null}
						project={currentProject}
						remoteChangeNotice={currentThreadId
							? (remoteChangeNotices.get(currentThreadId) ?? null)
							: null}
						pravaPublishableKey={page.data.env?.PUBLIC_PRAVA_PUBLISHABLE_KEY}
						onDismissRemoteChangeNotice={() => {
							if (currentThreadId) {
								remoteChangeNotices.delete(currentThreadId);
							}
						}}
					/>

					<PromptComposer
						bind:prompt
						attachments={composerAttachments}
						onAttachFiles={addComposerAttachments}
						onRemoveAttachment={removeComposerAttachment}
						{modelCatalog}
						bind:selectedModel
						bind:selectedReasoningEffort
						bind:selectedServiceTier
						pendingQuestion={pendingAgentQuestion}
						bind:selectedQuestionOptionId
						{canSend}
						isSubmitting={isSubmittingPrompt || hasPendingAgentLaunch || answeringAgentQuestion}
						isStarting={hasPendingAgentLaunch}
						{isRunning}
						elapsedLabel={isRunning ? formatElapsedDuration(elapsedSeconds) : null}
						{contextUsage}
						projectSkills={composerProjectSkills}
						onSubmit={() => {
							void submitPrompt();
						}}
						onCancel={() => {
							void cancelRun();
						}}
					/>
				{/if}
			</main>
		</div>

		{#if !settingsOpen && artifactPanel.open}
			<div
				class={artifactPanel.expanded
					? 'bg-background fixed inset-0 z-50'
					: 'absolute inset-y-0 right-0 z-40 w-[20rem]'}
				inert={fullscreenArtifact ? true : undefined}
			>
				<ArtifactPanel
					artifacts={threadArtifacts}
					selectedKey={artifactPanel.selectedKey}
					expanded={artifactPanel.expanded}
					onSelect={(key) => {
						artifactPanel = { ...artifactPanel, selectedKey: key };
					}}
					onBack={() => {
						artifactPanel = { ...artifactPanel, selectedKey: null };
					}}
					onOpenFullscreen={(key) => {
						artifactFullscreenKey = key;
						// Request in the click gesture so Firefox keeps true browser
						// fullscreen; the overlay only observes/exits the session.
						if (!document.fullscreenElement) {
							void document.documentElement.requestFullscreen?.().catch(() => {});
						}
					}}
					onToggleExpanded={() => {
						artifactPanel = { ...artifactPanel, expanded: !artifactPanel.expanded };
					}}
					onClose={() => {
						artifactPanel = { ...artifactPanel, open: false, expanded: false };
					}}
				/>
			</div>
		{/if}

		{#if fullscreenArtifact}
			<!-- No {#key}: remounting would exit document fullscreen during artifact switches. -->
			<ArtifactScreenFullscreen
				artifact={fullscreenArtifact}
				onClose={() => {
					artifactFullscreenKey = null;
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
					projectPickerReconnectProjectId = null;
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
