<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { z } from 'zod';
	import { elapsedSeconds, tickingNow } from '$lib/chat/elapsed-time';
	import { page } from '$app/state';
	import { PanelRight, PanelLeft } from '@lucide/svelte';
	import '$lib/components/home/inbox.css';
	import InboxSidebar from '$lib/components/home/inbox-sidebar.svelte';
	import CreateThreadHeading from '$lib/components/home/create-thread-heading.svelte';
	import SettingsInbox from '$lib/components/home/settings-inbox.svelte';
	import { useInbox } from '$lib/project/inbox.svelte';
	import { createProjectDefault } from '$lib/project/inbox';
	import { inboxState, type InboxState } from '$convex/lib/inboxState';
	import {
		composerDraftKey,
		completeComposerDraft,
		loadComposerDraft,
		saveComposerDraft,
		updateDraftAttachment,
		type ComposerDraft
	} from '$lib/chat/composer-drafts';
	import { saveDraftFile, loadDraftFile, deleteDraftFile } from '$lib/chat/draft-files';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { useAuth, useConvexClient, useMutation, useQuery } from 'convex-svelte';
	import { watchCloudArtifacts, type CloudArtifactScope } from '$lib/chat/cloud-artifacts';
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
	import SettingsAccount from '$lib/components/home/settings-account.svelte';
	import SettingsBrowser from '$lib/components/home/settings-browser.svelte';
	import SettingsPayments from '$lib/components/home/settings-payments.svelte';
	import SettingsSidebar, { type SettingsPage } from '$lib/components/home/settings-sidebar.svelte';
	import SettingsUsage from '$lib/components/home/settings-usage.svelte';
	import ThreadTranscript from '$lib/components/home/thread-transcript.svelte';
	import SidePanel from '$lib/components/home/side-panel.svelte';
	import ArtifactScreenFullscreen from '$lib/components/home/artifact-screen-fullscreen.svelte';
	import {
		EMPTY_ARTIFACT_WATCH_STATE,
		applyArtifactsWatchEvent,
		artifactEntryFromLocal,
		artifactRevisionFromLocal,
		artifactWatchScopeKey,
		artifactsWatchRequest,
		isCurrentArtifactsWatch,
		mergeArtifactSources,
		nextArtifactRevisionWatch,
		type ArtifactRevision,
		type ArtifactWatchState
	} from '$lib/chat/artifacts';
	import { DEFAULT_SIDE_PANEL_SNAPSHOT, type SidePanelSnapshot } from '$lib/chat/side-panel';
	import ProjectPicker, { type ProjectSelection } from '$lib/components/home/project-picker.svelte';
	import Button from '$lib/components/ui/button/button.svelte';
	import {
		attachLocalProject as attachLocalProjectForPath,
		launchAgentRun,
		lifecycleResumeKind,
		refreshDesktopProjectAttachments as refreshDesktopProjectAttachmentsFromDesktop,
		projectFromAttachment,
		resolveSubmissionId,
		type ProjectState
	} from '$lib/home/desktop';
	import { formatElapsedDuration } from '$lib/format';
	import { convexClientErrorMessage } from '$lib/convex-error';
	import {
		attachmentMediaType,
		fallbackAttachmentName,
		isPreviewableImageMediaType,
		revokeAttachmentPreview,
		type ComposerAttachment
	} from '$lib/chat/attachments';
	import { defaultModelId, defaultReasoningEffort } from '$convex/lib/models';
	import {
		CATALOG_UNAVAILABLE_MESSAGE,
		fetchGatewayModelCatalog,
		getCatalogModel,
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
		isAgentLaunchPending,
		isLatestRunReadyForThread,
		resolveExpiredAgentLaunch,
		resolvePendingAgentLaunch,
		resolvePendingCreatedThreadId,
		threadRecordToSummary,
		type PendingAgentLaunch,
		type PendingAgentLaunches
	} from '$lib/project/threads';
	import { mergeLiveOverlays } from '$lib/project/transcript';
	import { DisplayHistory, visibleDisplayMessages } from '$lib/project/display-history';
	import type { TranscriptDisplayRow, TranscriptDetailCursor } from '$lib/types/sprocket';
	import {
		clearLaunchHash,
		readWorkspaceLaunchFromHash,
		resolveDesktopApi
	} from '$lib/local/client';
	import { resolve } from '$app/paths';
	import { applyTheme, resolveTheme, type SprocketTheme } from '$lib/theme';
	import type {
		DesktopApi,
		ExecutorJob,
		LiveCompletionOverlay,
		ThreadCacheStatus,
		ThreadCacheUserRequest,
		TranscriptMessage,
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
	const workspaceReadable = $derived(
		authReady ||
			($authState.isReady &&
				!$authState.isLoading &&
				isSignedIn &&
				($authState.nativeSession === 'ready' || $authState.nativeSession === 'offline'))
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
	const answerAgentQuestion = useMutation(api.agentQuestions.answer);
	const setThemePreference = useMutation(api.uiPreferences.setTheme);
	const changeInboxState = useMutation(api.inbox.changeState);
	const renameInboxThread = useMutation(api.threads.renameForLocalCache);
	let sidebarOpen = $state(true);
	let viewportWidth = $state(0);
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
	let sidebarWidth = $state(300);
	let projectFilter = $state<string[]>([]);
	let recentProjects = $state<string[]>([]);
	const inbox = useInbox({
		userId: () => signedInUserId,
		enabled: () => getAuthenticatedQueryArgs() !== 'skip',
		cacheReady: () => workspaceReadable,
		projects: () => projectFilter,
		desktop: () => desktopApi
	});
	$effect(() => {
		const userId = signedInUserId;
		untrack(() => {
			try {
				recentProjects = z
					.array(z.string())
					.parse(JSON.parse(localStorage.getItem(`sprocket:recent-projects:${userId}`) ?? '[]'));
			} catch {
				recentProjects = [];
			}
			try {
				projectFilter = z
					.array(z.string())
					.max(100)
					.parse(JSON.parse(localStorage.getItem(`sprocket:inbox-filter:${userId}`) ?? '[]'));
			} catch {
				projectFilter = [];
			}
		});
	});
	function filterProjects(keys: string[]) {
		projectFilter = keys;
		try {
			localStorage.setItem(`sprocket:inbox-filter:${signedInUserId}`, JSON.stringify(keys));
		} catch {
			/* Filtering works without local storage. */
		}
	}
	function chooseDraftProject(key: string) {
		const project = findProjectByRepositoryKey(projects, key);
		if (!project) return;
		currentThreadId = null;
		currentRepositoryKey = key;
		currentWorkspacePath = project.workspacePath || null;
		draftWorkspacePath = currentWorkspacePath;
		projectSelectionGeneration += 1;
		rememberProject(key);
	}
	function rememberProject(key: string) {
		recentProjects = [key, ...recentProjects.filter((previous) => previous !== key)];
		try {
			localStorage.setItem(
				`sprocket:recent-projects:${signedInUserId}`,
				JSON.stringify(recentProjects)
			);
		} catch {
			/* Navigation still works without device storage. */
		}
	}
	function openCreateThread() {
		const saved = signedInUserId ? loadComposerDraft(composerDraftKey(signedInUserId, null)) : null;
		const recent = [
			...recentProjects,
			...Object.values(desktopProjectAttachmentsByPath)
				.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
				.map((attachment) => attachment.repositoryKey)
		];
		if (saved?.repositoryKey && (saved.prompt || saved.attachments.length))
			recent.unshift(saved.repositoryKey);
		const available = projects.map((project) => project.repositoryKey);
		if (saved?.repositoryKey) available.push(saved.repositoryKey);
		const key = createProjectDefault(available, projectFilter, recent);
		currentThreadId = null;
		pendingCreatedThreadId = null;
		currentError = null;
		settingsOpen = false;
		projectSelectionGeneration += 1;
		if (key) {
			currentRepositoryKey = key;
			currentWorkspacePath = findProjectByRepositoryKey(projects, key)?.workspacePath || null;
			draftWorkspacePath = currentWorkspacePath;
		} else {
			currentRepositoryKey = null;
			currentWorkspacePath = null;
			draftWorkspacePath = null;
		}
		if (matchMedia('(max-width: 767px)').matches) sidebarOpen = false;
		void tick().then(() =>
			document.querySelector<HTMLTextAreaElement>('.composer-draft textarea')?.focus()
		);
	}
	function openInboxThread(thread: Doc<'threadRecords'>) {
		inbox.remember(thread);
		rememberProject(thread.repositoryKey);
		const project = findProjectByRepositoryKey(projects, thread.repositoryKey);
		currentRepositoryKey = thread.repositoryKey;
		currentWorkspacePath = project?.workspacePath || null;
		currentThreadId = thread._id;
		draftWorkspacePath = null;
		settingsOpen = false;
		currentError = null;
		projectSelectionGeneration += 1;
		if (matchMedia('(max-width: 767px)').matches) sidebarOpen = false;
	}
	async function updateInboxThread(
		thread: Doc<'threadRecords'>,
		state: InboxState,
		snoozedUntil?: number,
		undo = false
	) {
		if (!inbox.online) throw new Error('Reconnect before changing thread state.');
		const generation = projectSelectionGeneration;
		const userId = signedInUserId;
		const record = await changeInboxState({
			threadId: thread._id,
			state,
			snoozedUntil,
			expectedState: inboxState(thread),
			expectedSnoozedUntil: thread.snoozedUntil ?? null
		});
		inbox.remember(record);
		if (
			!undo &&
			generation === projectSelectionGeneration &&
			userId === signedInUserId &&
			currentThreadId === thread._id &&
			(state === 'settled' || state === 'snoozed')
		)
			openCreateThread();
	}
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
	let composerAttachments = $state<ComposerAttachment[]>([]);
	let currentError = $state<string | null>(null);
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
	let projectSelectionGeneration = $state(0);
	let pendingCreatedThreadId = $state<Id<'threadRecords'> | null>(null);
	let desktopProjectAttachmentsByPath = $state<Record<string, ProjectAttachment>>({});
	let hasLoadedDesktopProjectAttachments = $state(false);
	let desktopProjectAttachmentsGeneration = 0;
	let threadCacheStatus = $state<ThreadCacheStatus>('loading');
	let threadSnapshotThreads = $state<Doc<'threadRecords'>[]>([]);
	let threadCacheGeneration = 0;
	let threadSnapshotPullGeneration = 0;
	let selectionUserId = $state<string | null>(null);
	let projectPickerOpen = $state(false);
	let projectPickerMode = $state<'add' | 'reconnect'>('add');
	let projectPickerExpectedDisplayName = $state<string | undefined>(undefined);
	let projectPickerExpectedRepositoryKey = $state<string | null>(null);
	let projectPickerReconnectWorkspacePath = $state<string | null>(null);
	let settingsOpen = $state(false);
	let settingsPage = $state<SettingsPage>('account');
	let pendingProjectLaunches = $state<string[]>([]);
	let projectLaunchInFlight = $state(false);
	let initialProjectLaunchResolved = $state(false);
	const remoteChangeNotices = new SvelteMap<Id<'threadRecords'>, string>();
	let artifactFullscreenKey = $state<string | null>(null);
	const REMOTE_CHANGE_NOTICE =
		'This directory’s git remote changed. Existing threads now follow the new repository.';
	function getCurrentUserId() {
		return signedInUserId;
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
	function updateOwnedAttachment(key: string, localId: string, patch: Partial<ComposerAttachment>) {
		return loadedDraftKey === key
			? updateComposerAttachment(localId, patch)
			: updateDraftAttachment(key, localId, patch);
	}

	function discardComposerUpload(args: {
		api?: DesktopApi | null;
		userId?: string | null;
		threadId?: Id<'threadRecords'> | null;
		storageId: Id<'_storage'>;
	}) {
		if (!inbox.online) return;
		try {
			const api = args.api ?? desktopApi;
			const userId = args.userId ?? getCurrentUserId();
			if (!api || !userId) {
				return;
			}
			void api
				.discardTranscriptAttachment({
					userId,
					storageId: args.storageId,
					threadId: args.threadId ?? undefined
				})
				.catch(() => {});
		} catch {
			return;
		}
	}

	const uploadingAttachments = new SvelteSet<string>();
	async function uploadComposerAttachment(
		attachment: ComposerAttachment,
		key: string,
		userId: string,
		threadId: Id<'threadRecords'> | null
	) {
		const { localId, name } = attachment;
		const api = desktopApi;
		try {
			if (!api) {
				throw new Error(localServerRequiredMessage);
			}
			const blob = await loadDraftFile(userId, localId);
			if (!blob) throw new Error('Attach this file again. Its local copy is unavailable.');
			if (getCurrentUserId() !== userId || !inbox.online) return;
			const file = new File([blob], name, { type: attachment.mediaType });
			const registered = await api.uploadTranscriptAttachment({
				userId,
				name,
				file,
				threadId: threadId ?? undefined
			});
			if ('error' in registered) {
				throw new Error(registered.error);
			}
			const stillAttached = updateOwnedAttachment(key, localId, {
				status: 'ready',
				uploadedAt: Date.now(),
				storageId: registered.storageId,
				name: registered.name,
				mediaType: registered.mediaType,
				size: registered.size,
				previewUrl: isPreviewableImageMediaType(registered.mediaType) ? registered.url : undefined
			});
			if (!stillAttached) {
				discardComposerUpload({
					api,
					userId,
					threadId,
					storageId: registered.storageId
				});
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Upload failed.';
			updateOwnedAttachment(key, localId, {
				status: 'error',
				error: message
			});
			if (loadedDraftKey === key) currentError = message;
		} finally {
			uploadingAttachments.delete(localId);
		}
	}
	$effect(() => {
		const userId = signedInUserId;
		const threadId = currentThreadId;
		const attachments = composerAttachments;
		if (!userId || !inbox.online) return;
		untrack(() => {
			for (const attachment of attachments) {
				if (
					attachment.status !== 'uploading' ||
					!attachment.fileSaved ||
					uploadingAttachments.has(attachment.localId)
				)
					continue;
				uploadingAttachments.add(attachment.localId);
				void uploadComposerAttachment(
					attachment,
					composerDraftKey(userId, threadId),
					userId,
					threadId
				);
			}
		});
	});

	function addComposerAttachments(files: File[]) {
		const userId = signedInUserId;
		if (!userId) return;
		const key = composerDraftKey(userId, currentThreadId);
		for (const file of files) {
			const localId = crypto.randomUUID();
			const name = fallbackAttachmentName(file);
			const mediaType = attachmentMediaType(file.type);
			composerAttachments = [
				...composerAttachments,
				{
					localId,
					name,
					mediaType,
					size: file.size,
					previewUrl: isPreviewableImageMediaType(mediaType)
						? URL.createObjectURL(file)
						: undefined,
					status: 'uploading'
				}
			];
			void saveDraftFile(userId, localId, file)
				.then(() => {
					if (!updateOwnedAttachment(key, localId, { fileSaved: true }))
						void deleteDraftFile(userId, localId).catch(() => {});
				})
				.catch(() =>
					updateOwnedAttachment(key, localId, {
						status: 'error',
						error: 'Could not save this file locally. Attach it again.'
					})
				);
		}
	}

	function removeComposerAttachment(localId: string) {
		const attachment = composerAttachments.find((entry) => entry.localId === localId);
		if (!attachment) {
			return;
		}
		revokeAttachmentPreview(attachment.previewUrl);
		if (signedInUserId) void deleteDraftFile(signedInUserId, localId).catch(() => {});
		composerAttachments = composerAttachments.filter((entry) => entry.localId !== localId);
		if (attachment.storageId) {
			discardComposerUpload({
				storageId: attachment.storageId,
				userId: getCurrentUserId(),
				threadId: currentThreadId
			});
		}
	}

	function clearComposerAttachments(options: {
		discard: boolean;
		userId?: string | null;
		threadId?: Id<'threadRecords'> | null;
	}) {
		const discardUserId = options.userId === undefined ? getCurrentUserId() : options.userId;
		const discardThreadId = options.threadId === undefined ? currentThreadId : options.threadId;
		for (const attachment of composerAttachments) {
			revokeAttachmentPreview(attachment.previewUrl);
			if (discardUserId) void deleteDraftFile(discardUserId, attachment.localId).catch(() => {});
			if (options.discard && attachment.storageId) {
				discardComposerUpload({
					userId: discardUserId,
					threadId: discardThreadId,
					storageId: attachment.storageId
				});
			}
		}
		composerAttachments = [];
	}

	function getComposerScope(threadId: Id<'threadRecords'> | null) {
		return threadId ? `thread:${threadId}` : 'draft';
	}
	let loadedDraftKey: string | null = null;
	let loadedDraftRepository: string | null = null;
	let draftPersistenceError = $state(false);
	let draftSubmission = $state<ComposerDraft['submission']>();
	function composerDraftSnapshot(): ComposerDraft {
		return {
			prompt,
			submission: draftSubmission,
			selectedModel,
			reasoningEffort: selectedReasoningEffort,
			fastMode,
			repositoryKey: currentRepositoryKey,
			attachments: composerAttachments.map((attachment) => ({
				...attachment,
				previewUrl: undefined
			}))
		};
	}
	$effect.pre(() => {
		const key =
			signedInUserId && selectionUserId === signedInUserId
				? composerDraftKey(signedInUserId, currentThreadId)
				: null;
		const repository = currentRepositoryKey;
		untrack(() => {
			if (loadedDraftKey === key) {
				loadedDraftRepository = repository;
				return;
			}
			if (loadedDraftKey)
				saveComposerDraft(loadedDraftKey, {
					...composerDraftSnapshot(),
					repositoryKey: loadedDraftRepository
				});
			loadedDraftKey = key;
			loadedDraftRepository = repository;
			const draft = key ? loadComposerDraft(key) : null;
			const thread =
				inbox.records.find((record) => record._id === currentThreadId) ??
				threadSnapshotThreads.find((record) => record._id === currentThreadId);
			draftSubmission = draft?.submission;
			if (!currentThreadId && !repository && draft?.repositoryKey)
				currentRepositoryKey = draft.repositoryKey;
			for (const attachment of composerAttachments) revokeAttachmentPreview(attachment.previewUrl);
			prompt = draft?.prompt ?? '';
			composerAttachments = draft?.attachments ?? [];
			selectedModel =
				draft?.selectedModel ??
				thread?.selectedModel ??
				modelCatalog?.defaultModelId ??
				defaultModelId;
			selectedReasoningEffort =
				draft?.reasoningEffort ??
				thread?.reasoningEffort ??
				modelCatalog?.defaultReasoningEffort ??
				defaultReasoningEffort;
			fastMode = draft?.fastMode ?? thread?.fastMode ?? false;
			composerContinuationOfRunId = null;
			autoSubmitComposerContinuation = false;
		});
	});
	$effect(() => {
		const key = signedInUserId ? composerDraftKey(signedInUserId, currentThreadId) : null;
		const draft = composerDraftSnapshot();
		if (!key || key !== loadedDraftKey) return;
		const timer = setTimeout(() => {
			draftPersistenceError = !saveComposerDraft(key, draft);
		}, 300);
		return () => clearTimeout(timer);
	});

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
		if (!inbox.online) {
			currentError = 'Reconnect before changing account settings.';
			return;
		}
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
	const projects = $derived.by<ProjectState[]>(() => {
		const byKey = new SvelteMap<string, ProjectState>();
		for (const attachment of Object.values(desktopProjectAttachmentsByPath).sort(
			(a, b) => b.lastUsedAt - a.lastUsedAt
		)) {
			if (!byKey.has(attachment.repositoryKey))
				byKey.set(attachment.repositoryKey, projectFromAttachment(attachment));
		}
		for (const record of [...inbox.projects, ...inbox.records]) {
			if (!byKey.has(record.repositoryKey))
				byKey.set(record.repositoryKey, {
					repositoryKey: record.repositoryKey,
					displayName: record.repositoryKey.split('/').at(-1) || record.repositoryKey,
					workspacePath: '',
					localAttachmentAvailability: 'unavailable',
					localAttachmentError: 'Project not connected here.'
				});
		}
		return [...byKey.values()];
	});
	const threads = $derived(
		[
			...new Map(
				[
					...threadSnapshotThreads,
					...inbox.records,
					...(activeThreadQuery.data ? [activeThreadQuery.data] : [])
				].map((thread) => [thread._id, thread])
			).values()
		].map(threadRecordToSummary)
	);
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
			autoHandoffTokenLimit: model?.autoHandoffTokenLimit ?? 0
		};
	});
	const currentLifecycle = $derived(dataForThread(lifecycleQuery.data, currentThreadId));
	const pendingAgentQuestion = $derived(
		dataForThread(pendingAgentQuestionQuery.data, currentThreadId)
	);
	let replicaMessages = $state.raw<TranscriptDisplayRow[]>([]);
	let replicaNextBefore = $state<number | null>(null);
	let replicaWindowVersion = $state(0);
	let replicaStale = $state(false);
	let replicaThreadId = $state<Id<'threadRecords'> | null>(null);
	let replicaLoading = $state(false);
	let replicaError = $state<string | null>(null);
	let replicaGeneration = 0;
	let transcriptHistory = $state.raw<DisplayHistory | null>(null);
	let transcriptAbort: AbortController | null = null;
	let loadingOlderTranscript = $state(false);
	let liveCompletion = $state.raw<LiveCompletionOverlay | null>(null);
	let pendingCompletions = $state.raw<LiveCompletionOverlay[]>([]);

	function showReplicaForThread(threadId: Id<'threadRecords'> | null) {
		replicaGeneration += 1;
		transcriptAbort?.abort();
		transcriptAbort = null;
		transcriptHistory?.stop();
		transcriptHistory = null;
		loadingOlderTranscript = false;
		replicaThreadId = threadId;
		liveCompletion = null;
		pendingCompletions = [];
		replicaError = null;
		replicaMessages = [];
		replicaNextBefore = null;
		replicaWindowVersion = 0;
		replicaStale = false;
		replicaLoading = threadId !== null;
	}

	$effect.pre(() => {
		const threadId = currentThreadId;
		if (replicaThreadId === threadId) {
			return;
		}
		untrack(() => showReplicaForThread(threadId));
	});

	$effect(() => {
		const threadId = currentThreadId;
		const api = desktopApi;
		if (!threadId || !api || !isSignedIn) {
			return;
		}
		const userId = untrack(() => getCurrentUserId());
		if (!userId) {
			return;
		}
		const ac = new AbortController();
		const watchedThreadId = threadId;
		transcriptAbort = ac;
		const generation = replicaGeneration;
		const history = new DisplayHistory(
			(request) =>
				api.fetchTranscriptDisplay(
					{
						userId,
						threadId: watchedThreadId,
						...request
					},
					ac.signal
				),
			() => {
				if (ac.signal.aborted || replicaGeneration !== generation) return;
				replicaMessages = history.messages;
				replicaNextBefore = history.nextBefore ?? null;
				replicaWindowVersion = history.windowVersion;
				replicaStale = history.stale;
				replicaLoading = history.loading;
				loadingOlderTranscript = history.loadingOlder;
				replicaError = history.error;
				const pendingCount = pendingCompletions.length;
				pendingCompletions = history
					.unpersisted([...pendingCompletions, ...(liveCompletion ? [liveCompletion] : [])])
					.filter((live) => live !== liveCompletion);
				if (pendingCompletions.length > 0 && pendingCompletions.length < pendingCount)
					void history.refresh();
			}
		);
		transcriptHistory = history;
		void history.refresh();
		void (async () => {
			while (!ac.signal.aborted) {
				try {
					await api.watchTranscript(
						{ userId, threadId: watchedThreadId },
						{
							signal: ac.signal,
							onEvent: (event) => {
								if (ac.signal.aborted || currentThreadId !== watchedThreadId) {
									return;
								}
								replicaStale = event.stale;
								void history.refresh();
							}
						}
					);
				} catch {
					if (!ac.signal.aborted) replicaStale = true;
				}
				if (!ac.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1_000));
			}
		})();
		return () => {
			ac.abort();
			history.stop();
		};
	});

	$effect(() => {
		const threadId = currentThreadId;
		const api = desktopApi;
		if (!threadId || !api || !isSignedIn) {
			return;
		}
		const userId = untrack(() => getCurrentUserId());
		if (!userId) {
			return;
		}
		const ac = new AbortController();
		const watchedThreadId = threadId;
		void (async () => {
			while (!ac.signal.aborted) {
				try {
					await api.watchLiveCompletion(
						{ userId, threadId: watchedThreadId },
						{
							signal: ac.signal,
							onEvent: (event) => {
								if (ac.signal.aborted || currentThreadId !== watchedThreadId) {
									return;
								}
								if (
									liveCompletion &&
									(event.eventType === 'cleared' || event.live.streamId !== liveCompletion.streamId)
								) {
									if (transcriptHistory?.unpersisted([liveCompletion]).length) {
										pendingCompletions = [...pendingCompletions, liveCompletion];
									}
									void transcriptHistory?.refresh();
								}
								if (event.eventType === 'updated') {
									liveCompletion = event.live;
								} else {
									liveCompletion = null;
								}
							}
						}
					);
				} catch {
					if (ac.signal.aborted) {
						return;
					}
				}
				if (ac.signal.aborted) {
					return;
				}
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, 400);
					ac.signal.addEventListener(
						'abort',
						() => {
							clearTimeout(timer);
							resolve();
						},
						{ once: true }
					);
				});
			}
		})();
		return () => {
			ac.abort();
		};
	});

	$effect(() => {
		const overlays = [...pendingCompletions, ...(liveCompletion ? [liveCompletion] : [])];
		const history = transcriptHistory;
		untrack(() => history?.setOverlays(overlays));
	});

	const visibleMessages = $derived.by((): TranscriptMessage[] => {
		const userId = getCurrentUserId();
		if (!currentThreadId || !userId || replicaThreadId !== currentThreadId) {
			return [];
		}
		const overlays =
			transcriptHistory?.visibleOverlays([
				...pendingCompletions,
				...(liveCompletion ? [liveCompletion] : [])
			]) ?? [];
		const messages = mergeLiveOverlays(
			overlays.filter((overlay) => overlay.threadId === currentThreadId)
		);
		return [
			...visibleDisplayMessages(replicaMessages, overlays),
			...messages.map((message) =>
				message.runId === runState?.runId
					? { ...message, runStartedAt: runState.startedAt, runCompletedAt: runState.completedAt }
					: message
			)
		];
	});

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

	const runState = $derived(currentLifecycle?.run ?? null);
	const visibleActions: ExecutorJob[] = [];
	let artifactWatchGeneration = 0;
	let artifactWatchState = $state<ArtifactWatchState>({ ...EMPTY_ARTIFACT_WATCH_STATE });
	let artifactWatchHasSnapshot = $state(false);
	let artifactWatchScope = $state<string | null>(null);
	const threadArtifacts = $derived(artifactWatchState.artifacts.map(artifactEntryFromLocal));
	// Panel state snapshots survive thread and project switches.
	const sidePanelSnapshots = new SvelteMap<string, SidePanelSnapshot>();
	let sidePanel = $state<SidePanelSnapshot>({ ...DEFAULT_SIDE_PANEL_SNAPSHOT });
	let sidePanelScopeKey: string | null = null;
	// Baseline for create/update detection; null means the next observation only seeds.
	let artifactRevisionWatch: {
		scopeKey: string;
		revisions: Map<string, ArtifactRevision>;
	} | null = null;
	// Baseline for browser-activity detection; same seeding rule as artifacts.
	let browserLiveViewWatch: {
		threadId: Id<'threadRecords'>;
		runId: Id<'runs'> | null;
	} | null = null;

	$effect(() => {
		const threadId = currentThreadId;
		const repositoryKey = currentRepositoryKey;
		const workspacePath = currentWorkspacePath;
		const userId = signedInUserId;
		const scopeKey =
			userId && repositoryKey
				? artifactWatchScopeKey({
						userId,
						repositoryKey,
						workspacePath: workspacePath ?? '',
						threadId
					})
				: null;
		if (scopeKey === sidePanelScopeKey) return;
		if (sidePanelScopeKey) {
			sidePanelSnapshots.set(sidePanelScopeKey, sidePanel);
		}
		sidePanelScopeKey = scopeKey;
		artifactFullscreenKey = null;
		sidePanel = {
			...((scopeKey && sidePanelSnapshots.get(scopeKey)) || DEFAULT_SIDE_PANEL_SNAPSHOT)
		};
	});

	$effect(() => {
		const localApi = desktopApi;
		const repositoryKey = currentRepositoryKey;
		const workspacePath = currentWorkspacePath;
		const threadId = currentThreadId;
		const userId = signedInUserId;
		const cloudReady = convexAuth.isAuthenticated && !convexAuth.isLoading;
		const generation = ++artifactWatchGeneration;
		artifactWatchHasSnapshot = false;
		artifactWatchState = { ...EMPTY_ARTIFACT_WATCH_STATE };
		artifactRevisionWatch = null;
		if (!repositoryKey || !userId) {
			artifactWatchScope = null;
			return;
		}
		const scope = {
			userId,
			repositoryKey,
			workspacePath: workspacePath ?? '',
			threadId
		};
		const scopeKey = artifactWatchScopeKey(scope);
		artifactWatchScope = scopeKey;
		const ac = new AbortController();
		const request = artifactsWatchRequest(scope);
		let cloud: ArtifactWatchState = { artifacts: [], stale: true, error: null };
		let local: ArtifactWatchState | null = null;
		const publish = () => {
			if (ac.signal.aborted || generation !== artifactWatchGeneration) return;
			artifactWatchState = mergeArtifactSources(cloud, local);
			if (!artifactWatchState.stale || artifactWatchState.artifacts.length > 0)
				artifactWatchHasSnapshot = true;
		};
		const cloudScope: CloudArtifactScope = { userId, repositoryKey };
		if (threadId) cloudScope.threadId = threadId;
		const stopCloud = cloudReady
			? watchCloudArtifacts(artifactClient, cloudScope, (snapshot) => {
					cloud = snapshot;
					publish();
				})
			: () => {};
		void (async () => {
			while (localApi && workspacePath && !ac.signal.aborted) {
				await localApi
					.watchArtifacts(request, {
						signal: ac.signal,
						onEvent: (event) => {
							if (
								!isCurrentArtifactsWatch({
									aborted: ac.signal.aborted,
									generation,
									currentGeneration: artifactWatchGeneration,
									eventScopeKey: scopeKey,
									currentScopeKey: artifactWatchScope
								})
							) {
								return;
							}
							local = applyArtifactsWatchEvent(event);
							publish();
						}
					})
					.catch(() => undefined);
				if (
					!ac.signal.aborted &&
					generation === artifactWatchGeneration &&
					artifactWatchScope === scopeKey
				) {
					local = null;
					publish();
				}
				if (!ac.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1_000));
			}
		})();
		return () => {
			ac.abort();
			stopCloud();
		};
	});

	$effect(() => {
		const scopeKey = artifactWatchScope;
		const hasSnapshot = artifactWatchHasSnapshot;
		const artifacts = artifactWatchState.artifacts;
		if (!scopeKey || !hasSnapshot) {
			if (artifactRevisionWatch && artifactRevisionWatch.scopeKey !== scopeKey) {
				artifactRevisionWatch = null;
			}
			return;
		}
		if (artifactRevisionWatch && artifactRevisionWatch.scopeKey !== scopeKey) {
			artifactRevisionWatch = null;
		}

		const current = artifacts.map(artifactRevisionFromLocal);
		const previous = artifactRevisionWatch?.revisions ?? null;
		const { revisions, changedId } = nextArtifactRevisionWatch(previous, current);
		artifactRevisionWatch = { scopeKey, revisions };

		if (!changedId) return;
		// Avoid depending on panel UI state for re-runs; only follow selection when
		// opening or when the user is still on the list view.
		const prior = untrack(() => sidePanel);
		sidePanel = {
			...prior,
			open: true,
			// Don't yank the user off the live view they deliberately opened.
			tab: prior.open ? prior.tab : 'artifacts',
			selectedKey: !prior.open || prior.selectedKey === null ? changedId : prior.selectedKey
		};
	});

	// The agent started working with the browser tools when the session's
	// lastUsedRunId becomes the currently active run: open the side panel
	// straight onto the live view. Keying on the run (not session starts)
	// catches runs that reuse the previous session, and doesn't re-open for
	// mid-run session rotations or after the user closed the panel.
	$effect(() => {
		const threadId = currentThreadId;
		const data = browserLiveViewQuery.data;
		const activeRunId = isRunning ? (runState?.runId ?? null) : null;
		if (!threadId) {
			browserLiveViewWatch = null;
			return;
		}
		if (browserLiveViewWatch && browserLiveViewWatch.threadId !== threadId) {
			browserLiveViewWatch = null;
		}
		if (data === undefined) return;

		const sessionRunId = data?.lastUsedRunId ?? null;
		const previous = browserLiveViewWatch;
		browserLiveViewWatch = { threadId, runId: sessionRunId };
		if (sessionRunId === null || sessionRunId !== activeRunId) return;
		if (previous && previous.runId === sessionRunId) return;

		const prior = untrack(() => sidePanel);
		if (prior.open && prior.tab === 'live') return;
		sidePanel = { ...prior, open: true, tab: 'live' };
	});

	const fullscreenArtifact = $derived(
		threadArtifacts.find((artifact) => artifact.key === artifactFullscreenKey) ?? null
	);
	const currentComposerScope = $derived(getComposerScope(currentThreadId));
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
			inbox.online &&
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
		await registerThreadCacheForCurrentUser();
	}

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
		await pullThreadSnapshot(userId);
	}

	function applyThreadCacheEvent(event: {
		status: ThreadCacheStatus;
		lastSyncedAt: number | null;
	}) {
		threadCacheStatus = event.status;
	}

	async function pullThreadSnapshot(userId: string) {
		const api = desktopApi;
		if (!api) {
			return;
		}
		const generation = ++threadSnapshotPullGeneration;
		const snapshot = await api.fetchThreadSnapshot({ userId });
		if (generation !== threadSnapshotPullGeneration || getCurrentUserId() !== userId) {
			return;
		}
		threadSnapshotThreads = snapshot.threads;
		applyThreadCacheEvent(snapshot);
	}

	async function registerThreadCacheForCurrentUser(
		selectedThreadId: Id<'threadRecords'> | null = currentThreadId
	) {
		const api = desktopApi;
		const userId = getCurrentUserId();
		if (!api || !userId) {
			return;
		}
		if (getCurrentUserId() !== userId) {
			return;
		}
		const request: ThreadCacheUserRequest = { userId };
		if (selectedThreadId) {
			request.selectedThreadId = selectedThreadId;
		}
		const event = await api.registerThreadCache(request);
		if (getCurrentUserId() !== userId) {
			return;
		}
		applyThreadCacheEvent(event);
		await pullThreadSnapshot(userId);
	}

	$effect(() => {
		const api = desktopApi;
		const userId = signedInUserId;
		if (!api || !userId || !authReady) {
			return;
		}
		const generation = ++threadCacheGeneration;
		const ac = new AbortController();
		void (async () => {
			try {
				try {
					await registerThreadCacheForCurrentUser();
				} catch {
					await pullThreadSnapshot(userId);
				}
				if (generation !== threadCacheGeneration || ac.signal.aborted) {
					return;
				}
				await api.watchThreadCache(
					{ userId },
					{
						signal: ac.signal,
						onEvent: (event) => {
							if (generation !== threadCacheGeneration || getCurrentUserId() !== userId) {
								return;
							}
							applyThreadCacheEvent(event);
							if (event.status === 'live' || event.status === 'reconnecting') {
								void pullThreadSnapshot(userId);
							}
						}
					}
				);
			} catch (error) {
				if (generation !== threadCacheGeneration || getCurrentUserId() !== userId) {
					return;
				}
				threadCacheStatus = 'error';
				currentError = error instanceof Error ? error.message : 'Could not sync threads.';
			}
		})();
		return () => {
			ac.abort();
		};
	});

	$effect(() => {
		const api = desktopApi;
		const userId = signedInUserId;
		const selectedThreadId = currentThreadId;
		if (!api || !userId || !authReady) {
			return;
		}
		void registerThreadCacheForCurrentUser(selectedThreadId).catch(() => {});
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
		const nextAttachments = {
			...desktopProjectAttachmentsByPath,
			[attachment.workspacePath]: attachment
		};
		if (replaceWorkspacePath && replaceWorkspacePath !== attachment.workspacePath) {
			delete nextAttachments[replaceWorkspacePath];
		}
		desktopProjectAttachmentsByPath = nextAttachments;
		hasLoadedDesktopProjectAttachments = true;
		return attachment;
	}

	function openProjectPicker(
		mode: 'add' | 'reconnect' = 'add',
		workspacePath: string | null = null,
		repositoryKey: string | null = null
	) {
		if (!desktopApi) {
			currentError = localServerRequiredMessage;
			return;
		}

		projectPickerMode = mode;
		projectPickerReconnectWorkspacePath = workspacePath;
		projectPickerExpectedRepositoryKey = repositoryKey;
		const reconnectProject = findProjectByRepositoryKey(projects, repositoryKey);
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
			if (projectPickerMode === 'reconnect' && projectPickerExpectedRepositoryKey) {
				if (selection.repositoryKey !== projectPickerExpectedRepositoryKey) {
					throw new Error(
						`Choose a folder for ${projectPickerExpectedRepositoryKey}. This folder belongs to ${selection.repositoryKey}.`
					);
				}
				const generation = projectSelectionGeneration;
				const selectedThreadId = currentThreadId;
				await attachLocalProject(
					selection.workspacePath,
					projectPickerReconnectWorkspacePath ?? undefined
				);
				if (getCurrentUserId() === pickerUserId && generation === projectSelectionGeneration) {
					setProjectSelection(selection.workspacePath, selectedThreadId, !selectedThreadId);
				}
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

	async function persistSelectedModel(modelId: CatalogModelId) {
		const threadId = currentThreadId;
		const userId = getCurrentUserId();
		if (!threadId || !userId || !inbox.online) {
			return;
		}

		try {
			await setThreadSelectedModel({ threadId, selectedModel: modelId });
			if (getCurrentUserId() === userId) {
				void pullThreadSnapshot(userId);
			}
		} catch (error) {
			if (currentThreadId === threadId && getCurrentUserId() === userId) {
				currentError =
					error instanceof Error ? error.message : 'Failed to save the selected model.';
			}
		}
	}

	async function loadOlderTranscript() {
		await transcriptHistory?.loadOlder();
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

	async function submitAgentQuestionAnswer() {
		if (!inbox.online) return;
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
		const submittedAttachments = composerAttachments.map((attachment) => ({ ...attachment }));
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
		if (!inbox.online) return;
		if (
			composerAttachments.some(
				(attachment) =>
					attachment.uploadedAt && Date.now() - attachment.uploadedAt >= 23 * 3_600_000
			)
		) {
			composerAttachments = composerAttachments.map((attachment) =>
				attachment.uploadedAt && Date.now() - attachment.uploadedAt >= 23 * 3_600_000
					? {
							...attachment,
							status: attachment.fileSaved ? 'uploading' : 'error',
							storageId: undefined,
							uploadedAt: undefined,
							error: attachment.fileSaved
								? undefined
								: 'Attach this file again. Its local copy is unavailable.'
						}
					: attachment
			);
			currentError = 'Refreshing file uploads. Send again when the files are ready.';
			return;
		}
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

		if (!prompt.trim() && composerAttachments.length === 0) {
			return;
		}

		if (composerAttachments.some((attachment) => attachment.status !== 'ready')) {
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
		const submittedAttachments = composerAttachments.map((attachment) => ({ ...attachment }));
		const submittedStorageIds = submittedAttachments.flatMap((attachment) =>
			attachment.storageId ? [attachment.storageId] : []
		);
		const submittedModel = selectedModel;
		const submittedReasoningEffort = selectedReasoningEffort;
		const submittedFastMode = fastMode;
		const submittedContinuationOfRunId =
			options?.continuationOfRunId ?? composerContinuationOfRunId ?? undefined;
		const previousRunId = selectedThreadId ? (runState?.runId ?? null) : null;
		const submissionScope = getComposerScope(selectedThreadId);
		const submittedDraftKey = composerDraftKey(submittedUserId, selectedThreadId);
		const selectionGeneration = projectSelectionGeneration;
		const originatingRecoveryScope = submissionScope;
		let recoveryScope = originatingRecoveryScope;
		const originatingRecoveryKey = getComposerRecoveryKey(
			submittedUserId,
			originatingRecoveryScope
		);
		const recoveredSubmission = recoveredSubmissionIds.get(originatingRecoveryKey);
		const freshSubmissionId = crypto.randomUUID();
		const fingerprint = () =>
			JSON.stringify([
				submittedRepositoryKey,
				submittedPrompt,
				submittedStorageIds,
				submittedModel,
				submittedReasoningEffort,
				submittedFastMode,
				submittedContinuationOfRunId
			]);
		const submissionFingerprint = fingerprint();
		const threadSubmissionId = resolveSubmissionId({
			latestRun:
				!selectedThreadId || !currentLifecycle || currentLifecycle.phase === 'idle'
					? null
					: {
							runId: runState?.runId,
							status: isLifecycleInProgress(currentLifecycle.phase) ? 'queued' : 'completed',
							submissionId: currentRecoveredSubmission?.submissionId ?? ''
						},
			newSubmissionId:
				draftSubmission?.fingerprint === submissionFingerprint
					? draftSubmission.id
					: freshSubmissionId,
			prompt: submittedPrompt,
			storageIds: submittedStorageIds,
			reasoningEffort: submittedReasoningEffort,
			fastMode: submittedFastMode,
			continuationOfRunId: submittedContinuationOfRunId,
			recoveredSubmission:
				recoveredSubmission &&
				(selectedThreadId || draftSubmission?.fingerprint === submissionFingerprint)
					? {
							...recoveredSubmission,
							selectedModel: recoveredSubmission.selectedModel
						}
					: undefined,
			selectedModel: submittedModel
		});
		const runSubmissionId = threadSubmissionId;
		draftSubmission = { id: threadSubmissionId, fingerprint: submissionFingerprint };
		saveComposerDraft(submittedDraftKey, composerDraftSnapshot());
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
		currentError = null;
		submittingPromptScopes.set(submissionScope, submissionSequence);

		try {
			if (!selectedThreadId) {
				const resolution = await desktopApi.resolveWorkspacePath({ workspacePath });
				if (!isSubmissionCurrent()) {
					return;
				}
				if (resolution.repositoryKey !== submittedRepositoryKey) {
					await attachLocalProject(resolution.workspacePath);
					if (!isSubmissionCurrent()) {
						return;
					}
					const siblingStillHasPreviousKey = projects.some(
						(project) =>
							project.workspacePath !== resolution.workspacePath &&
							project.repositoryKey === submittedRepositoryKey
					);
					if (!siblingStillHasPreviousKey && getAuthenticatedQueryArgs() !== 'skip') {
						await rekeyLocalRepository(submittedRepositoryKey, resolution.repositoryKey);
					}
					if (!isSubmissionCurrent()) {
						return;
					}
					const previousRepositoryKey = submittedRepositoryKey;
					submittedRepositoryKey = resolution.repositoryKey;
					if (projectSelectionGeneration === selectionGeneration)
						currentRepositoryKey = resolution.repositoryKey;
					const submission = { id: threadSubmissionId, fingerprint: fingerprint() };
					if (loadedDraftKey === submittedDraftKey) {
						draftSubmission = submission;
						saveComposerDraft(submittedDraftKey, composerDraftSnapshot());
					} else {
						const draft = loadComposerDraft(submittedDraftKey);
						if (draft)
							saveComposerDraft(submittedDraftKey, {
								...draft,
								submission,
								repositoryKey:
									draft.repositoryKey === previousRepositoryKey
										? submittedRepositoryKey
										: draft.repositoryKey
							});
					}
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
					const draft =
						loadedDraftKey === submittedDraftKey
							? { ...composerDraftSnapshot(), attachments: composerAttachments }
							: loadComposerDraft(submittedDraftKey);
					const remaining = draft
						? completeComposerDraft(draft, {
								prompt: submittedPrompt,
								attachments: submittedAttachments,
								repositoryKey: submittedRepositoryKey
							})
						: null;
					if (remaining) {
						saveComposerDraft(submittedDraftKey, remaining);
						if (loadedDraftKey === submittedDraftKey) {
							prompt = remaining.prompt;
							draftSubmission = remaining.submission;
							composerAttachments = remaining.attachments;
						}
					}
					for (const attachment of submittedAttachments) {
						if (remaining?.attachments.some((entry) => entry.localId === attachment.localId))
							continue;
						revokeAttachmentPreview(attachment.previewUrl);
						void deleteDraftFile(submittedUserId, attachment.localId).catch(() => {});
					}
					if (!selectedThreadId) {
						launchedThreadId = createdThreadId;
						const replyKey = composerDraftKey(submittedUserId, createdThreadId);
						if (!loadComposerDraft(replyKey))
							saveComposerDraft(replyKey, {
								prompt: '',
								attachments: [],
								repositoryKey: submittedRepositoryKey,
								selectedModel: submittedModel,
								reasoningEffort: submittedReasoningEffort,
								fastMode: submittedFastMode
							});
						if (projectSelectionGeneration === selectionGeneration) {
							pendingCreatedThreadId = createdThreadId;
							projectSelectionGeneration += 1;
							currentThreadId = createdThreadId;
							draftWorkspacePath = null;
						}
						void pullThreadSnapshot(submittedUserId);
						if (repositoryKeyChanged)
							remoteChangeNotices.set(createdThreadId, REMOTE_CHANGE_NOTICE);
					}
					if (
						loadedDraftKey === submittedDraftKey &&
						composerContinuationOfRunId === submittedContinuationOfRunId
					) {
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
		if (!inbox.online) return;
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
		if (!inbox.online) return;
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

		selectionUserId = userId;
		hasResolvedInitialSelection = false;
		currentWorkspacePath = null;
		currentRepositoryKey = null;
		currentThreadId = null;
		draftWorkspacePath = null;
		pendingCreatedThreadId = null;
		pendingAgentLaunches = {};
		ensureSubscriptionAttemptedFor = null;
		threadCacheStatus = 'loading';
		threadSnapshotThreads = [];
		threadSnapshotPullGeneration += 1;
		projectSelectionGeneration += 1;
		composerContinuationOfRunId = null;
		autoSubmitComposerContinuation = false;
		currentError = null;
		projectPickerOpen = false;
		projectPickerReconnectWorkspacePath = null;
		projectPickerExpectedDisplayName = undefined;
		sidePanelSnapshots.clear();
		sidePanelScopeKey = null;
		sidePanel = { ...DEFAULT_SIDE_PANEL_SNAPSHOT };
		artifactFullscreenKey = null;
		artifactRevisionWatch = null;
	});

	$effect(() => {
		if (!pendingCreatedThreadId) {
			return;
		}

		const nextPendingCreatedThreadId = resolvePendingCreatedThreadId({
			pendingCreatedThreadId,
			threads: threadSnapshotThreads.map(threadRecordToSummary)
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
		const userId = getCurrentUserId();
		const recoveryScope = getComposerScope(currentThreadId);
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
			composerAttachments.length === 0 &&
			recovery.attachments?.length &&
			(canRestorePrompt || prompt === recovery.prompt)
		) {
			composerAttachments = recovery.attachments.map((attachment) => ({ ...attachment }));
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
			composerAttachments.some((attachment) => attachment.status !== 'ready')
		) {
			return;
		}
		autoSubmitComposerContinuation = false;
		void submitPrompt();
	});

	$effect(() => {
		if (
			hasResolvedInitialSelection ||
			!initialProjectLaunchResolved ||
			pendingProjectLaunches.length > 0 ||
			projectLaunchInFlight
		) {
			return;
		}

		if (!hasLoadedDesktopProjectAttachments || !signedInUserId) {
			return;
		}

		hasResolvedInitialSelection = true;
		untrack(openCreateThread);
	});

	$effect(() => {
		const activeThreadSummary = currentThreadId ? findThreadById(threads, currentThreadId) : null;
		const threadProject =
			currentProject?.repositoryKey === activeThreadSummary?.repositoryKey
				? currentProject
				: findProjectByRepositoryKey(projects, activeThreadSummary?.repositoryKey);
		if (
			currentThreadId &&
			threadProject?.workspacePath &&
			threadProject.workspacePath !== currentWorkspacePath
		) {
			setProjectSelection(
				threadProject.workspacePath,
				currentThreadId,
				draftWorkspacePath === threadProject.workspacePath
			);
		}
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
		const saveDraftBeforeExit = () => {
			if (loadedDraftKey) saveComposerDraft(loadedDraftKey, composerDraftSnapshot());
		};
		window.addEventListener('beforeunload', saveDraftBeforeExit);
		sidebarOpen = !matchMedia('(max-width: 767px)').matches;
		try {
			sidebarWidth = Math.max(
				240,
				Math.min(440, Number(localStorage.getItem('sprocket:inbox-width')) || 300)
			);
		} catch {
			/* Use the default width when storage is unavailable. */
		}
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

		return () => {
			saveDraftBeforeExit();
			window.removeEventListener('beforeunload', saveDraftBeforeExit);
			unsubscribeWorkspaceLaunch?.();
		};
	});
</script>

<svelte:window bind:innerWidth={viewportWidth} />

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
{:else if !workspaceReadable}
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
			sidePanel.open &&
			!sidePanel.expanded
				? 'pr-[20rem]'
				: ''}"
			class:sidebar-hidden={!sidebarOpen}
			style:--inbox-width={`${sidebarWidth}px`}
			inert={fullscreenArtifact || (sidePanel.open && sidePanel.expanded) ? true : undefined}
		>
			{#if sidebarOpen}<button
					class="fixed inset-0 z-[140] bg-black/40 md:hidden"
					aria-label="Close sidebar"
					onclick={() => void closeSidebar()}
				></button>{/if}
			<div class="inbox-sidebar-host" inert={!sidebarOpen}>
				{#if settingsOpen}
					<SettingsSidebar
						online={inbox.online}
						activePage={settingsPage}
						theme={workspaceTheme}
						onThemeChange={(theme) => void handleThemeChange(theme)}
						onBack={() => {
							projectSelectionGeneration += 1;
							settingsOpen = false;
							settingsPage = 'account';
						}}
						onNavigate={(page) => {
							settingsPage = page;
							if (matchMedia('(max-width: 767px)').matches) sidebarOpen = false;
						}}
					/>
				{:else}
					{#key signedInUserId}<InboxSidebar
							sections={inbox.sections}
							{projects}
							selectedProjects={projectFilter}
							{currentThreadId}
							userId={signedInUserId ?? ''}
							online={inbox.online}
							migrating={inbox.migrating}
							error={inbox.error}
							theme={workspaceTheme}
							onThemeChange={(theme) => void handleThemeChange(theme)}
							onFilter={filterProjects}
							onSelect={openInboxThread}
							onNew={openCreateThread}
							onAddProject={() => openProjectPicker('add')}
							onSettings={() => {
								projectSelectionGeneration += 1;
								settingsPage = 'inbox';
								settingsOpen = true;
								if (matchMedia('(max-width: 767px)').matches) sidebarOpen = false;
							}}
							onClose={() => void closeSidebar()}
							onChange={updateInboxThread}
							onRename={async (thread, title) => {
								if (!inbox.online) throw new Error('Reconnect before renaming.');
								await renameInboxThread({ threadId: thread._id, title });
							}}
						/>{/key}
				{/if}
				<button
					type="button"
					class="inbox-resize"
					aria-label={`Resize sidebar, ${sidebarWidth} pixels. Use left and right arrows.`}
					onkeydown={(event) => {
						if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
							event.preventDefault();
							sidebarWidth = Math.max(
								240,
								Math.min(440, sidebarWidth + (event.key === 'ArrowLeft' ? -10 : 10))
							);
						}
					}}
					onpointerdown={(event) => {
						event.currentTarget.setPointerCapture(event.pointerId);
					}}
					onpointermove={(event) => {
						if (event.currentTarget.hasPointerCapture(event.pointerId))
							sidebarWidth = Math.max(240, Math.min(440, event.clientX));
					}}
					onpointerup={(event) => {
						event.currentTarget.releasePointerCapture(event.pointerId);
						try {
							localStorage.setItem('sprocket:inbox-width', String(sidebarWidth));
						} catch {
							/* Width remains usable without persistence. */
						}
					}}
				></button>
			</div>

			<main
				class="relative flex h-screen min-h-0 min-w-0 flex-col overflow-hidden"
				inert={sidebarOpen && viewportWidth < 768}
			>
				{#if !sidebarOpen}<button
						class="inbox-icon absolute top-3 left-3 z-50"
						aria-label="Open sidebar"
						onclick={() => void openSidebar()}><PanelLeft size={18} /></button
					>{/if}
				{#if !settingsOpen && !sidePanel.open}
					<button
						type="button"
						class="text-muted-foreground hover:text-foreground hover:bg-muted absolute top-3 right-3 z-100 inline-flex items-center justify-center rounded-md p-2 transition"
						onclick={() => {
							sidePanel = { ...sidePanel, open: true };
						}}
						aria-label="Open side panel"
					>
						<PanelRight class="size-4" aria-hidden="true" />
					</button>
				{/if}
				{#if settingsOpen}
					{#if settingsPage === 'inbox'}
						<SettingsInbox
							online={inbox.online}
							days={uiPreferencesQuery.data?.autoSettleDays === undefined
								? 7
								: uiPreferencesQuery.data.autoSettleDays}
						/>
					{:else if settingsPage === 'usage'}
						<SettingsUsage />
					{:else if settingsPage === 'browser'}
						<SettingsBrowser online={inbox.online} />
					{:else if settingsPage === 'payments'}
						<SettingsPayments online={inbox.online} />
					{:else}
						<SettingsAccount user={$authState.user} onSignOut={() => void signOut()} />
					{/if}
				{:else}
					{#if currentThreadId}
						{#key `${currentThreadId}:${replicaWindowVersion}`}
							<ThreadTranscript
								currentError={replicaError ??
									currentError ??
									$authState.error ??
									(queryError instanceof Error ? convexClientErrorMessage(queryError) : null) ??
									(threadCacheStatus === 'error' ? 'Could not sync threads.' : null) ??
									(threadCacheStatus === 'offline' ? 'Thread sync is offline.' : null) ??
									null}
								runError={latestRunResumeKind ? null : (runState?.lastError ?? null)}
								messages={visibleMessages}
								actions={visibleActions}
								activeRunId={isRunInProgress ? (runState?.runId ?? null) : null}
								project={currentProject}
								remoteChangeNotice={currentThreadId
									? (remoteChangeNotices.get(currentThreadId) ?? null)
									: null}
								onDismissRemoteChangeNotice={() => {
									if (currentThreadId) {
										remoteChangeNotices.delete(currentThreadId);
									}
								}}
								stale={replicaStale}
								loadingOlder={loadingOlderTranscript}
								nextBefore={replicaNextBefore ?? undefined}
								emptyStateMessage={currentThreadId &&
								(replicaLoading || replicaThreadId !== currentThreadId)
									? ''
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
					<div class={!currentThreadId ? 'inbox-create' : ''}>
						{#if !currentThreadId}<CreateThreadHeading
								{projects}
								repositoryKey={currentRepositoryKey}
								onProject={chooseDraftProject}
								onAddProject={() => openProjectPicker('add')}
							/>{/if}
						{#if currentProject?.localAttachmentAvailability === 'unavailable'}<p
								class="inbox-create-message"
							>
								Project not connected here. <button
									onclick={() =>
										openProjectPicker('reconnect', currentWorkspacePath, currentRepositoryKey)}
									>Connect a local folder</button
								> to start local work.
							</p>{/if}
						{#if !currentThreadId && currentError}<p
								class="inbox-create-message text-destructive"
								role="alert"
							>
								{currentError}
							</p>{/if}

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

						<div class={!currentThreadId ? 'composer-draft' : ''}>
							<PromptComposer
								bind:prompt
								attachments={composerAttachments}
								onAttachFiles={addComposerAttachments}
								onRemoveAttachment={removeComposerAttachment}
								{modelCatalog}
								bind:selectedModel
								onModelChange={(modelId) => {
									void persistSelectedModel(modelId);
								}}
								bind:selectedReasoningEffort
								bind:fastMode
								pendingQuestion={pendingAgentQuestion}
								showContinueWorking={inbox.online && latestRunResumeKind != null}
								onContinueWorking={() => {
									void continueWorking();
								}}
								bind:selectedQuestionOptionId
								{canSend}
								isSubmitting={isSubmittingPrompt || hasPendingAgentLaunch || answeringAgentQuestion}
								isStarting={hasPendingAgentLaunch}
								isRunning={inbox.online && isRunning}
								elapsedLabel={runElapsedSeconds === undefined
									? null
									: formatElapsedDuration(runElapsedSeconds)}
								{contextUsage}
								projectSkills={composerProjectSkills}
								onSubmit={() => {
									void submitPrompt();
								}}
								onCancel={() => {
									void cancelRun();
								}}
							/>
						</div>
						{#if !currentThreadId && (prompt || composerAttachments.length)}<div
								class="inbox-create-message"
							>
								<button
									onclick={() => {
										prompt = '';
										draftSubmission = undefined;
										clearComposerAttachments({ discard: true });
									}}>Clear draft</button
								>
							</div>{/if}
						{#if draftPersistenceError}<p class="inbox-create-message" role="alert">
								Draft changes are only saved for this session. Local storage is unavailable.
							</p>{/if}
					</div>
				{/if}
			</main>
		</div>

		{#if !settingsOpen && sidePanel.open}
			<div
				class={sidePanel.expanded
					? 'bg-background fixed inset-0 z-50'
					: 'absolute inset-y-0 right-0 z-40 w-[20rem]'}
				inert={fullscreenArtifact ? true : undefined}
			>
				<SidePanel
					artifacts={threadArtifacts}
					selectedKey={sidePanel.selectedKey}
					tab={sidePanel.tab}
					liveView={currentThreadId ? browserLiveViewQuery.data : null}
					liveActive={isRunning && browserLiveViewQuery.data?.lastUsedRunId === runState?.runId}
					expanded={sidePanel.expanded}
					stale={artifactWatchState.stale}
					error={artifactWatchState.error}
					onSelect={(key) => {
						sidePanel = { ...sidePanel, selectedKey: key };
					}}
					onBack={() => {
						sidePanel = { ...sidePanel, selectedKey: null };
					}}
					onTabChange={(tab) => {
						sidePanel = { ...sidePanel, tab };
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
						sidePanel = { ...sidePanel, expanded: !sidePanel.expanded };
					}}
					onClose={() => {
						sidePanel = { ...sidePanel, open: false, expanded: false };
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
