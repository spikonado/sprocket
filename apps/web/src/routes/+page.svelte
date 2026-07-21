<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { useAuth, useMutation, useQuery } from 'convex-svelte';
	import type { Id } from '$convex/_generated/dataModel';
	import { api } from '$convex/_generated/api';
	import { EXECUTOR_HEARTBEAT_WRITE_THROTTLE_MS } from '$convex/lib/workspaceConnection';
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
	import SettingsSidebar, { type SettingsPage } from '$lib/components/home/settings-sidebar.svelte';
	import SettingsUsage from '$lib/components/home/settings-usage.svelte';
	import ThreadTranscript from '$lib/components/home/thread-transcript.svelte';
	import WorkspacePicker, {
		type WorkspaceSelection
	} from '$lib/components/home/workspace-picker.svelte';
	import WorkspaceSidebar from '$lib/components/home/workspace-sidebar.svelte';
	import {
		attachLocalWorkspaceSession as attachLocalWorkspaceSessionForPath,
		createLatestTaskQueue,
		getDesiredAttachedWorkspaceSessionIds,
		isRunBlockingAgentLaunch,
		launchAgentRun,
		refreshDesktopWorkspaceSessions as refreshDesktopWorkspaceSessionsFromDesktop,
		resolveDraftRunSubmissionId,
		resolveSubmissionId,
		verifyWorkspaceSession as verifyWorkspaceSessionForExecution,
		type WorkspaceSessionState
	} from '$lib/home/desktop';
	import { formatElapsedDuration } from '$lib/format';
	import { validateImageAttachmentAddition, type ComposerAttachment } from '$lib/chat/attachments';
	import {
		defaultModelId,
		defaultReasoningEffort,
		defaultServiceTier,
		type SupportedModelId,
		type SupportedReasoningEffort,
		type SupportedServiceTier
	} from '$convex/lib/models';
	import { isClaimedRunStatus } from '$convex/lib/runLease';
	import {
		beginPendingAgentLaunch,
		clearPendingAgentLaunch,
		dataForThread,
		findThreadById,
		findWorkspaceSessionByName,
		getWorkspaceThreadGroups,
		isActiveThread,
		isAgentLaunchPending,
		isLatestRunReadyForThread,
		resolveExpiredAgentLaunch,
		resolvePendingAgentLaunch,
		resolvePendingAgentLaunchesFromThreads,
		resolvePendingCreatedThreadId,
		resolveWorkspaceThreadSelection,
		type PendingAgentLaunches
	} from '$lib/workspace/threads';
	import {
		holdLiveMessagesUntilHistoryAbsorbs,
		mergeThreadTranscriptMessages
	} from '$lib/workspace/transcript';
	import {
		clearLaunchHash,
		readWorkspaceLaunchFromHash,
		resolveDesktopApi
	} from '$lib/local/client';
	import { resolve } from '$app/paths';
	import type {
		DesktopApi,
		ThreadMessage,
		ThreadSummary,
		WorkspaceSession,
		WorkspaceSessionLocation,
		WorkspaceThreadGroup
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
	const upsertWorkspaceSession = useMutation(api.workspaceSessions.upsertSelected);
	const createThreadMutation = useMutation(api.threads.create);
	const renameThreadMutation = useMutation(api.threads.rename);
	const archiveThreadMutation = useMutation(api.threads.archive);
	const restoreThreadMutation = useMutation(api.threads.restore);
	const finalizeRun = useMutation(api.agentRuntime.finalizeRun);
	const setLastThread = useMutation(api.uiPreferences.setLastThread);
	const generateImageUploadUrl = useMutation(api.imageUploads.generateUploadUrl);
	const registerImageUpload = useMutation(api.imageUploads.register);
	const discardImageUpload = useMutation(api.imageUploads.discard);
	const heartbeatAttached = useMutation(api.workspaceSessions.heartbeatAttached);
	const ensureMySubscription = useMutation(api.billing.ensureMySubscription);
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
	const localServerRequiredMessage = 'Connect to a running Sprocket server to use this workspace.';
	const agentLaunchTimeoutMs = 30_000;
	type ComposerRecovery = {
		message: string;
		prompt: string;
		attachments?: ComposerAttachment[];
		imageUploadIds?: Id<'imageUploads'>[];
		reasoningEffort?: SupportedReasoningEffort;
		serviceTier?: SupportedServiceTier;
		selectedModel?: SupportedModelId;
		submissionId?: string;
	};
	const workspaceAttachmentHeartbeatQueue = createLatestTaskQueue(
		async (request: { clientId: string; workspaceSessionIds: Id<'workspaceSessions'>[] }) => {
			await heartbeatAttached({
				clientId: request.clientId,
				workspaceSessionIds: request.workspaceSessionIds
			});
		}
	);

	let desktopApi = $state<DesktopApi | null>(null);
	let desktopApiResolved = $state(false);
	let currentWorkspaceName = $state<string | null>(null);
	let currentThreadId = $state<Id<'threadRecords'> | null>(null);
	let draftWorkspaceName = $state<string | null>(null);
	let selectedModel = $state<SupportedModelId>(defaultModelId);
	let selectedReasoningEffort = $state<SupportedReasoningEffort>(defaultReasoningEffort);
	let selectedServiceTier = $state<SupportedServiceTier>(defaultServiceTier);
	let prompt = $state('');
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
			selectedModel: SupportedModelId;
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
	let restoredWorkspaceSessionIdToAttach = $state<Id<'workspaceSessions'> | null>(null);
	let lastSavedThreadId = $state<Id<'threadRecords'> | null>(null);
	let lastSyncedComposerThreadId: Id<'threadRecords'> | null = null;
	let workspaceSelectionGeneration = $state(0);
	let pendingCreatedThreadId = $state<Id<'threadRecords'> | null>(null);
	let desktopWorkspaceSessionsById = $state<Record<string, WorkspaceSessionLocation>>({});
	let hasLoadedDesktopWorkspaceSessions = $state(false);
	let desktopWorkspaceSessionsGeneration = 0;
	let selectionUserId = $state<string | null>(null);
	let workspacePickerOpen = $state(false);
	let workspacePickerMode = $state<'add' | 'reconnect'>('add');
	let workspacePickerExpectedName = $state<string | undefined>(undefined);
	let workspacePickerReconnectSessionId = $state<Id<'workspaceSessions'> | null>(null);
	let settingsOpen = $state(false);
	let settingsPage = $state<SettingsPage>('account');
	let pendingWorkspaceLaunches = $state<string[]>([]);
	let workspaceLaunchInFlight = $state(false);
	let initialWorkspaceLaunchResolved = $state(false);
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
		workspaceSessionId: Id<'workspaceSessions'> | null
	) {
		return threadId
			? `thread:${threadId}`
			: workspaceSessionId
				? `draft:${workspaceSessionId}`
				: null;
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

	const workspaceSessionsQuery = useQuery(
		api.workspaceSessions.listMine,
		getAuthenticatedQueryArgs
	);
	const threadsQuery = useQuery(api.threads.listMine, getAuthenticatedQueryArgs);
	const uiPreferencesQuery = useQuery(api.uiPreferences.getMine, getAuthenticatedQueryArgs);
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
	const queryError = $derived.by(() => {
		for (const query of [
			workspaceSessionsQuery,
			threadsQuery,
			uiPreferencesQuery,
			activeThreadQuery,
			historyMessagesQuery,
			liveMessagesQuery,
			latestRunQuery
		]) {
			if (query.error) {
				return query.error;
			}
		}

		return null;
	});
	const workspaceSessions = $derived.by<WorkspaceSessionState[]>(() =>
		((workspaceSessionsQuery.data ?? []) as WorkspaceSession[]).map((session) => {
			const desktopWorkspace = desktopWorkspaceSessionsById[session._id];
			return {
				...session,
				workspacePath: desktopWorkspace?.workspacePath,
				localWorkspaceAvailability: desktopWorkspace
					? desktopWorkspace.availability
					: ('unlinked' as const),
				localWorkspaceError: desktopWorkspace?.unavailableReason
			};
		})
	);
	const threads = $derived((threadsQuery.data ?? []) as ThreadSummary[]);
	const currentActiveThread = $derived(dataForThread(activeThreadQuery.data, currentThreadId));
	const currentLatestRunData = $derived(dataForThread(latestRunQuery.data, currentThreadId));
	const currentHistoryMessagesData = $derived(
		dataForThread(historyMessagesQuery.data, currentThreadId)
	);
	const currentLiveMessagesData = $derived(dataForThread(liveMessagesQuery.data, currentThreadId));
	// Hold the last live page across finalization until history absorbs those IDs.
	// Only assign when the held page identity changes — a fresh `[]` each effect
	// tick would infinite-loop under Svelte 5 and freeze UI reactivity.
	let heldLiveMessages = $state<ThreadMessage[]>([]);
	$effect(() => {
		if (!currentHistoryMessagesData || !currentLiveMessagesData) {
			if (heldLiveMessages.length > 0) {
				heldLiveMessages = [];
			}
			return;
		}
		const nextHeld = holdLiveMessagesUntilHistoryAbsorbs({
			historyMessages: currentHistoryMessagesData.messages as ThreadMessage[],
			liveMessages: currentLiveMessagesData.messages as ThreadMessage[],
			heldLiveMessages
		});
		if (nextHeld !== heldLiveMessages) {
			heldLiveMessages = nextHeld;
		}
	});
	// Wait for both subscriptions so thread switches do not briefly show one side alone.
	// Prefer live query data while present so streaming stays synchronous with Convex.
	const visibleMessages = $derived.by(() => {
		if (!currentHistoryMessagesData || !currentLiveMessagesData) {
			return [] as ThreadMessage[];
		}
		const liveMessages = currentLiveMessagesData.messages as ThreadMessage[];
		return mergeThreadTranscriptMessages({
			historyMessages: currentHistoryMessagesData.messages as ThreadMessage[],
			liveMessages: liveMessages.length > 0 ? liveMessages : heldLiveMessages
		});
	});

	const currentWorkspaceSession = $derived.by<WorkspaceSessionState | null>(() => {
		if (!currentWorkspaceName) {
			return null;
		}

		return findWorkspaceSessionByName(workspaceSessions, currentWorkspaceName);
	});

	const currentWorkspaceSessionId = $derived(currentWorkspaceSession?._id ?? null);

	const currentWorkspaceThreads = $derived.by<ThreadSummary[]>(() => {
		if (!currentWorkspaceName) {
			return [];
		}

		return threads
			.filter((thread) => thread.workspaceName === currentWorkspaceName && isActiveThread(thread))
			.sort((left, right) => right.lastMessageAt - left.lastMessageAt);
	});

	const groupedWorkspaceThreads = $derived.by<WorkspaceThreadGroup[]>(() =>
		getWorkspaceThreadGroups(workspaceSessions, threads)
	);

	const runState = $derived(currentLatestRunData?.run ?? null);
	const visibleActions = $derived((currentLatestRunData?.jobs ?? []).slice(-60));
	const currentComposerScope = $derived(
		getComposerScope(currentThreadId, currentWorkspaceSessionId)
	);
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
			currentWorkspaceSessionId &&
			currentWorkspaceSession?.localWorkspaceAvailability === 'available' &&
			!isRunning &&
			!isSubmittingPrompt &&
			!hasPendingAgentLaunch &&
			isLatestRunReady
		)
	);
	const desiredAttachedWorkspaceSessionIds = $derived.by<Id<'workspaceSessions'>[]>(() =>
		getDesiredAttachedWorkspaceSessionIds(
			Object.values(desktopWorkspaceSessionsById),
			workspaceSessions.map((workspaceSession) => workspaceSession._id)
		)
	);
	const desiredAttachedWorkspaceSessionIdsKey = $derived.by(() =>
		[...desiredAttachedWorkspaceSessionIds].sort().join('\0')
	);
	const recentWorkspaceDirectories = $derived.by(() => {
		const seen = new SvelteSet<string>();
		const recents: Array<{ workspacePath: string; workspaceName: string }> = [];

		for (const session of Object.values(desktopWorkspaceSessionsById)) {
			if (session.availability !== 'available' || seen.has(session.workspacePath)) {
				continue;
			}

			seen.add(session.workspacePath);
			const workspaceName =
				session.workspacePath.split(/[/\\]/).filter(Boolean).at(-1) ?? session.workspacePath;
			recents.push({
				workspacePath: session.workspacePath,
				workspaceName
			});
		}

		return recents.sort((left, right) => right.workspaceName.localeCompare(left.workspaceName));
	});

	async function refreshDesktopWorkspaceSessions() {
		const refreshGeneration = ++desktopWorkspaceSessionsGeneration;
		const nextWorkspaceSessions = await refreshDesktopWorkspaceSessionsFromDesktop(desktopApi);
		if (refreshGeneration !== desktopWorkspaceSessionsGeneration) {
			return;
		}

		desktopWorkspaceSessionsById = nextWorkspaceSessions;
		hasLoadedDesktopWorkspaceSessions = true;
	}

	function applyWorkspaceSelection(
		workspaceName: string,
		threadId: Id<'threadRecords'> | null = null,
		draft: boolean = false
	) {
		currentWorkspaceName = workspaceName;
		currentThreadId = threadId;
		draftWorkspaceName = draft ? workspaceName : null;
		if (threadId !== pendingCreatedThreadId) {
			pendingCreatedThreadId = null;
		}
	}

	function setWorkspaceSelection(
		workspaceName: string,
		threadId: Id<'threadRecords'> | null = null,
		draft: boolean = false,
		preserveError: boolean = false
	) {
		workspaceSelectionGeneration += 1;
		if (!preserveError) {
			currentError = null;
		}
		applyWorkspaceSelection(workspaceName, threadId, draft);
	}

	async function attachLocalWorkspaceSession(
		workspaceSessionId: Id<'workspaceSessions'>,
		workspacePath: string
	) {
		if (!desktopApi) {
			throw new Error(localServerRequiredMessage);
		}

		const session = await attachLocalWorkspaceSessionForPath({
			desktopApi,
			workspaceSessionId,
			workspacePath
		});
		desktopWorkspaceSessionsGeneration += 1;
		desktopWorkspaceSessionsById = {
			...desktopWorkspaceSessionsById,
			[session.workspaceSessionId]: session
		};
		hasLoadedDesktopWorkspaceSessions = true;
		return session;
	}

	function openWorkspaceSession(
		workspaceName: string,
		selection: { threadId?: Id<'threadRecords'> | null; draft?: boolean } = {}
	) {
		const workspaceSession = findWorkspaceSessionByName(workspaceSessions, workspaceName);
		if (!workspaceSession) {
			currentError = 'Choose a workspace first.';
			return;
		}

		setWorkspaceSelection(workspaceName, selection.threadId, selection.draft);
		const selectionGeneration = workspaceSelectionGeneration;
		void verifyWorkspaceSession(workspaceSession._id).catch((error) => {
			if (selectionGeneration === workspaceSelectionGeneration) {
				currentError = error instanceof Error ? error.message : 'Failed to attach workspace.';
			}
		});
	}

	function openWorkspacePicker(
		mode: 'add' | 'reconnect' = 'add',
		workspaceSessionId: Id<'workspaceSessions'> | null = null
	) {
		if (!desktopApi || !executorClientId) {
			currentError = localServerRequiredMessage;
			return;
		}

		workspacePickerMode = mode;
		workspacePickerReconnectSessionId = workspaceSessionId;
		workspacePickerExpectedName =
			mode === 'reconnect' && workspaceSessionId
				? workspaceSessions.find((session) => session._id === workspaceSessionId)?.workspaceName
				: undefined;
		workspacePickerOpen = true;
		currentError = null;
	}

	async function handleWorkspaceSelected(selection: WorkspaceSelection) {
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
			if (workspacePickerMode === 'reconnect' && workspacePickerReconnectSessionId) {
				const reconnectSession = workspaceSessions.find(
					(session) => session._id === workspacePickerReconnectSessionId
				);
				if (!reconnectSession) {
					currentError = 'Workspace session not found.';
					return;
				}

				await attachLocalWorkspaceSession(
					workspacePickerReconnectSessionId,
					selection.workspacePath
				);
				if (getCurrentUserId() !== pickerUserId) {
					return;
				}
				setWorkspaceSelection(reconnectSession.workspaceName, currentThreadId);
				currentError = null;
				return;
			}

			await addWorkspaceSelection(selection, pickerUserId, pickerClientId);
		} catch (error) {
			if (getCurrentUserId() !== pickerUserId) {
				return;
			}
			currentError = error instanceof Error ? error.message : 'Failed to attach workspace.';
			throw error;
		}
	}

	async function addWorkspaceSelection(
		selection: WorkspaceSelection,
		expectedUserId: string,
		connectedClientId: string
	) {
		const session = await upsertWorkspaceSession({
			workspaceName: selection.workspaceName,
			connectedClientId
		});
		if (!session) {
			throw new Error('Failed to create or update the workspace session.');
		}
		if (getCurrentUserId() !== expectedUserId) {
			return;
		}

		await attachLocalWorkspaceSession(session._id, selection.workspacePath);
		if (getCurrentUserId() !== expectedUserId) {
			return;
		}
		setWorkspaceSelection(session.workspaceName, null, true);
		currentError = null;
	}

	function queueWorkspaceLaunch(workspacePath: string | null | undefined) {
		const normalizedPath = workspacePath?.trim();
		if (!normalizedPath) {
			return;
		}

		pendingWorkspaceLaunches = [...pendingWorkspaceLaunches, normalizedPath];
	}

	async function takeDesktopWorkspaceLaunches() {
		const bridge = window.sprocketDesktopBridge;
		if (!bridge?.takeWorkspaceLaunch) {
			return;
		}

		while (true) {
			const workspacePath = await bridge.takeWorkspaceLaunch();
			if (!workspacePath) {
				return;
			}
			queueWorkspaceLaunch(workspacePath);
		}
	}

	async function openLaunchedWorkspace(
		workspacePath: string,
		client: DesktopApi,
		userId: string,
		clientId: string
	) {
		const selection = await client.resolveWorkspacePath({ workspacePath });
		if (getCurrentUserId() !== userId) {
			return;
		}
		await addWorkspaceSelection(selection, userId, clientId);
	}

	async function verifyWorkspaceSession(workspaceSessionId: Id<'workspaceSessions'>) {
		await verifyWorkspaceSessionForExecution({
			desktopApi,
			refreshDesktopWorkspaceSessions,
			workspaceSessionId
		});
	}

	function reconnectWorkspaceSession(workspaceSessionId: Id<'workspaceSessions'>) {
		openWorkspacePicker('reconnect', workspaceSessionId);
	}

	function schedulePendingCreatedThreadExpiration(args: {
		prompt: string;
		attachments: ComposerAttachment[];
		imageUploadIds: Id<'imageUploads'>[];
		reasoningEffort: SupportedReasoningEffort;
		serviceTier: SupportedServiceTier;
		selectedModel: SupportedModelId;
		submissionId: string;
		threadId: Id<'threadRecords'>;
		userId: string;
		workspaceName: string;
		workspaceSessionId: Id<'workspaceSessions'>;
	}) {
		window.setTimeout(() => {
			if (
				getCurrentUserId() !== args.userId ||
				pendingCreatedThreadId !== args.threadId ||
				currentThreadId !== args.threadId ||
				currentWorkspaceName !== args.workspaceName ||
				threads.some((thread) => thread.threadId === args.threadId)
			) {
				return;
			}

			pendingCreatedThreadId = null;
			setWorkspaceSelection(args.workspaceName, null, true);
			const recoveryScope = getComposerScope(null, args.workspaceSessionId);
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
		selectedModel: SupportedModelId;
		selectedReasoningEffort: SupportedReasoningEffort;
		selectedServiceTier: SupportedServiceTier;
		submissionId: string;
		userId: string;
		workspaceName: string;
		workspaceSessionId: Id<'workspaceSessions'>;
	}) {
		const result = await createThreadMutation({
			submissionId: args.submissionId,
			workspaceSessionId: args.workspaceSessionId,
			selectedModel: args.selectedModel,
			reasoningEffort: args.selectedReasoningEffort,
			serviceTier: args.selectedServiceTier
		});
		if (!args.isSubmissionCurrent()) {
			return null;
		}

		if (
			args.userId === getCurrentUserId() &&
			args.selectionGeneration === workspaceSelectionGeneration
		) {
			pendingCreatedThreadId = result.threadId;
			workspaceSelectionGeneration += 1;
			currentThreadId = result.threadId;
			draftWorkspaceName = null;
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
				workspaceName: args.workspaceName,
				workspaceSessionId: args.workspaceSessionId
			});
		}

		return result;
	}

	function startThreadDraftForWorkspace(workspaceName: string) {
		openWorkspaceSession(workspaceName, { draft: true });
	}

	function selectThread(thread: ThreadSummary) {
		openWorkspaceSession(thread.workspaceName, { threadId: thread.threadId });
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
					workspaceSelectionGeneration += 1;
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

	async function submitPrompt() {
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

		const workspaceSessionId = currentWorkspaceSessionId;
		if (!workspaceSessionId) {
			currentError = 'Choose a workspace first.';
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
					: currentWorkspaceSession?.localWorkspaceAvailability === 'available'
						? 'You need an active workspace session before sending.'
						: 'This workspace needs to be attached before sending.';
			return;
		}

		elapsedSeconds = 0;

		const selectionGeneration = workspaceSelectionGeneration;
		const selectedThreadId = currentThreadId;
		const submittedWorkspaceName = currentWorkspaceName;
		if (!submittedWorkspaceName) {
			currentError = 'Choose a workspace first.';
			return;
		}
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
		let submissionScope = selectedThreadId
			? `thread:${selectedThreadId}`
			: `draft:${workspaceSessionId}`;
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
			recoveredSubmission,
			selectedModel: submittedModel
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
						workspaceName: submittedWorkspaceName,
						workspaceSessionId
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
			}
			const authToken = await getAccessToken();
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
				expectedUserId: submittedUserId,
				getAccessToken,
				getCurrentUserId: () => $authState.user?.id ?? null,
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
				selectedModel: submittedModel,
				submissionId: runSubmissionId,
				reasoningEffort: submittedReasoningEffort,
				serviceTier: submittedServiceTier,
				workspaceSessionId
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
			void refreshDesktopWorkspaceSessions().catch(() => {});
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
		const recoveryScope = getComposerScope(currentThreadId, currentWorkspaceSessionId);
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
		currentWorkspaceName = null;
		currentThreadId = null;
		draftWorkspaceName = null;
		pendingCreatedThreadId = null;
		pendingAgentLaunches = {};
		restoredWorkspaceSessionIdToAttach = null;
		lastSavedThreadId = null;
		ensureSubscriptionAttemptedFor = null;
		lastSyncedComposerThreadId = null;
		workspaceSelectionGeneration += 1;
		prompt = '';
		clearComposerAttachments({ discard: true });
		currentError = null;
		elapsedSeconds = 0;
		selectedModel = defaultModelId;
		selectedReasoningEffort = defaultReasoningEffort;
		selectedServiceTier = defaultServiceTier;
		workspacePickerOpen = false;
		workspacePickerReconnectSessionId = null;
		workspacePickerExpectedName = undefined;
	});

	$effect(() => {
		const workspacePath = pendingWorkspaceLaunches[0];
		const client = desktopApi;
		const userId = getCurrentUserId();
		const clientId = executorClientId;
		if (
			!workspacePath ||
			workspaceLaunchInFlight ||
			!authReady ||
			!client ||
			!userId ||
			!clientId ||
			workspaceSessionsQuery.data === undefined
		) {
			return;
		}

		pendingWorkspaceLaunches = pendingWorkspaceLaunches.slice(1);
		workspaceLaunchInFlight = true;
		hasResolvedInitialSelection = true;
		restoredWorkspaceSessionIdToAttach = null;
		workspacePickerOpen = false;
		settingsOpen = false;
		currentError = null;
		void openLaunchedWorkspace(workspacePath, client, userId, clientId)
			.catch((error) => {
				if (getCurrentUserId() === userId) {
					hasResolvedInitialSelection = false;
					currentError =
						error instanceof Error ? error.message : 'Failed to open the requested workspace.';
				}
			})
			.finally(() => {
				workspaceLaunchInFlight = false;
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
		const recoveryScope = getComposerScope(currentThreadId, currentWorkspaceSessionId);
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
					serviceTier: recovery.serviceTier ?? defaultServiceTier,
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
			!initialWorkspaceLaunchResolved ||
			pendingWorkspaceLaunches.length > 0 ||
			workspaceLaunchInFlight
		) {
			return;
		}

		if (!workspaceSessionsQuery.data || !threadsQuery.data || uiPreferences === undefined) {
			return;
		}

		hasResolvedInitialSelection = true;
		const restoredThread = findThreadById(threads, uiPreferences?.lastThreadId ?? null);
		if (restoredThread && isActiveThread(restoredThread)) {
			setWorkspaceSelection(restoredThread.workspaceName, restoredThread.threadId, false, true);
			restoredWorkspaceSessionIdToAttach =
				findWorkspaceSessionByName(workspaceSessions, restoredThread.workspaceName)?._id ??
				restoredThread.workspaceSessionId;
			lastSavedThreadId = restoredThread.threadId;
			return;
		}

		if (workspaceSessions[0]) {
			setWorkspaceSelection(workspaceSessions[0].workspaceName, null, false, true);
			restoredWorkspaceSessionIdToAttach = workspaceSessions[0]._id;
		}
	});

	$effect(() => {
		const workspaceSessionId = restoredWorkspaceSessionIdToAttach;
		if (!workspaceSessionId || !desktopApi || !hasLoadedDesktopWorkspaceSessions) {
			return;
		}

		const workspaceSession = workspaceSessions.find(
			(session) => session._id === workspaceSessionId
		);
		if (!workspaceSession) {
			restoredWorkspaceSessionIdToAttach = null;
			return;
		}

		restoredWorkspaceSessionIdToAttach = null;
		const selectionGeneration = workspaceSelectionGeneration;
		void verifyWorkspaceSession(workspaceSessionId).catch((error) => {
			if (selectionGeneration === workspaceSelectionGeneration) {
				currentError = error instanceof Error ? error.message : 'Failed to attach workspace.';
			}
		});
	});

	$effect(() => {
		const activeThreadSummary = currentThreadId ? findThreadById(threads, currentThreadId) : null;
		if (
			activeThreadSummary?.workspaceName &&
			activeThreadSummary.workspaceName !== currentWorkspaceName
		) {
			setWorkspaceSelection(
				activeThreadSummary.workspaceName,
				currentThreadId,
				draftWorkspaceName === activeThreadSummary.workspaceName
			);
		}
	});

	$effect(() => {
		const threads = currentWorkspaceThreads;
		if (!hasResolvedInitialSelection || !currentWorkspaceName) {
			return;
		}

		const nextThreadId = resolveWorkspaceThreadSelection({
			threads,
			currentThreadId,
			currentWorkspaceName,
			draftWorkspaceName,
			pendingCreatedThreadId
		});
		if (nextThreadId === currentThreadId) {
			return;
		}

		setWorkspaceSelection(
			currentWorkspaceName,
			nextThreadId,
			draftWorkspaceName === currentWorkspaceName,
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
		const workspaceSessionIdsKey = desiredAttachedWorkspaceSessionIdsKey;
		if (
			!clientId ||
			!desktopApi ||
			!hasLoadedDesktopWorkspaceSessions ||
			workspaceSessionsQuery.data === undefined ||
			getAuthenticatedQueryArgs() === 'skip'
		) {
			return;
		}
		const request = {
			clientId,
			workspaceSessionIds: workspaceSessionIdsKey
				? (workspaceSessionIdsKey.split('\0') as Id<'workspaceSessions'>[])
				: []
		};

		void workspaceAttachmentHeartbeatQueue.enqueue(request).catch(() => {});

		const intervalId = window.setInterval(() => {
			void workspaceAttachmentHeartbeatQueue.enqueue(request).catch(() => {});
		}, EXECUTOR_HEARTBEAT_WRITE_THROTTLE_MS);

		return () => {
			window.clearInterval(intervalId);
			workspaceAttachmentHeartbeatQueue.cancelPending();
		};
	});

	onMount(() => {
		executorClientId = crypto.randomUUID();
		const bridge = window.sprocketDesktopBridge;
		const unsubscribeWorkspaceLaunch = bridge?.onWorkspaceLaunch
			? bridge.onWorkspaceLaunch(() => {
					void takeDesktopWorkspaceLaunches();
				})
			: undefined;
		const workspacePath = readWorkspaceLaunchFromHash();
		if (workspacePath) {
			queueWorkspaceLaunch(workspacePath);
			clearLaunchHash();
		}
		if (bridge?.takeWorkspaceLaunch) {
			void takeDesktopWorkspaceLaunches().finally(() => {
				initialWorkspaceLaunchResolved = true;
			});
		} else {
			initialWorkspaceLaunchResolved = true;
		}

		void resolveDesktopApi()
			.then((client) => {
				desktopApi = client;
				desktopApiResolved = true;
				void refreshDesktopWorkspaceSessions().catch((error) => {
					currentError =
						error instanceof Error ? error.message : 'Failed to load local workspace sessions.';
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
			<a
				class="inline-flex h-10 items-center justify-center rounded-xl bg-white px-4 text-sm font-medium text-black transition hover:bg-slate-100"
				href={resolve('/pair')}
			>
				Open pairing
			</a>
		{/snippet}
	</CalmCentered>
{:else if !authReady}
	<div class="h-screen overflow-hidden bg-[#0f1218]">
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
	<div class="h-screen overflow-hidden">
		<div
			class="grid h-screen grid-cols-[292px_minmax(0,1fr)] overflow-hidden bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.05),transparent_26%),linear-gradient(180deg,rgba(22,22,24,0.98),rgba(15,15,17,1))]"
		>
			{#if settingsOpen}
				<SettingsSidebar
					activePage={settingsPage}
					onBack={() => {
						settingsOpen = false;
						settingsPage = 'account';
					}}
					onNavigate={(page) => {
						settingsPage = page;
					}}
				/>
			{:else}
				<WorkspaceSidebar
					{currentWorkspaceName}
					{currentThreadId}
					groups={groupedWorkspaceThreads}
					{pendingAgentLaunches}
					onChooseWorkspace={() => {
						openWorkspacePicker('add');
					}}
					onReconnectWorkspace={(workspaceSessionId) => {
						void reconnectWorkspaceSession(workspaceSessionId);
					}}
					onOpenSettings={() => {
						settingsPage = 'account';
						settingsOpen = true;
					}}
					onStartThreadDraft={startThreadDraftForWorkspace}
					onSelectThread={selectThread}
					onRenameThread={(threadId, title) => {
						void renameThread(threadId, title);
					}}
					onArchiveThread={(threadId) => {
						void archiveThread(threadId);
					}}
				/>
			{/if}

			<main class="flex h-screen min-h-0 min-w-0 flex-col overflow-hidden">
				{#if settingsOpen}
					{#if settingsPage === 'archived'}
						<SettingsArchived
							{threads}
							onRestore={(threadId) => {
								void restoreThread(threadId);
							}}
						/>
					{:else if settingsPage === 'usage'}
						<SettingsUsage />
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
						workspaceSession={currentWorkspaceSession}
					/>

					<PromptComposer
						bind:prompt
						attachments={composerAttachments}
						onAttachFiles={addComposerAttachments}
						onRemoveAttachment={removeComposerAttachment}
						bind:selectedModel
						bind:selectedReasoningEffort
						bind:selectedServiceTier
						{canSend}
						isSubmitting={isSubmittingPrompt || hasPendingAgentLaunch}
						isStarting={hasPendingAgentLaunch}
						{isRunning}
						elapsedLabel={isRunning ? formatElapsedDuration(elapsedSeconds) : null}
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

		{#if desktopApi && workspacePickerOpen}
			<WorkspacePicker
				open={workspacePickerOpen}
				{desktopApi}
				mode={workspacePickerMode}
				expectedWorkspaceName={workspacePickerExpectedName}
				recentWorkspaces={recentWorkspaceDirectories}
				onClose={() => {
					workspacePickerOpen = false;
					workspacePickerReconnectSessionId = null;
					workspacePickerExpectedName = undefined;
				}}
				onSelect={async (selection) => {
					try {
						await handleWorkspaceSelected(selection);
					} catch {
						await refreshDesktopWorkspaceSessions();
					}
				}}
			/>
		{/if}
	</div>
{/if}
