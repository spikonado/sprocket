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
	import PromptComposer from '$lib/components/home/prompt-composer.svelte';
	import ThreadTranscript from '$lib/components/home/thread-transcript.svelte';
	import WorkspacePicker from '$lib/components/home/workspace-picker.svelte';
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
	import {
		defaultModelId,
		defaultReasoningEffort,
		type SupportedModelId,
		type SupportedReasoningEffort
	} from '$convex/lib/models';
	import { isClaimedRunStatus } from '$convex/lib/runLease';
	import {
		beginPendingAgentLaunch,
		clearPendingAgentLaunch,
		dataForThread,
		findThreadById,
		findWorkspaceSessionByName,
		getThreadDeletionBlockMessage,
		getWorkspaceThreadGroups,
		isAgentLaunchPending,
		isLatestRunReadyForThread,
		isSelectionGenerationCurrent,
		resolveExpiredAgentLaunch,
		resolvePendingAgentLaunch,
		resolvePendingAgentLaunchesFromThreads,
		resolvePendingCreatedThreadId,
		resolveWorkspaceThreadSelection,
		type PendingAgentLaunches
	} from '$lib/workspace/threads';
	import { resolveDesktopApi } from '$lib/local/client';
	import { resolve } from '$app/paths';
	import type {
		DesktopApi,
		ThreadMessage,
		ThreadSummary,
		WorkspaceOverview,
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
	const removeThread = useMutation(api.threads.remove);
	const finalizeRun = useMutation(api.agentRuntime.finalizeRun);
	const setLastThread = useMutation(api.uiPreferences.setLastThread);
	const heartbeatAttached = useMutation(api.workspaceSessions.heartbeatAttached);
	const localServerRequiredMessage = 'Connect to a running Sprocket server to use this workspace.';
	const agentLaunchTimeoutMs = 30_000;
	type ComposerRecovery = {
		message: string;
		prompt: string;
		reasoningEffort?: SupportedReasoningEffort;
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
	let prompt = $state('');
	let currentError = $state<string | null>(null);
	let executorClientId = $state<string | null>(null);
	let visibleMessages = $state<ThreadMessage[]>([]);
	let elapsedSeconds = $state(0);
	const submittingPromptScopes = new SvelteMap<string, number>();
	const composerRecoveries = new SvelteMap<string, ComposerRecovery>();
	const recoveredSubmissionIds = new SvelteMap<
		string,
		{
			prompt: string;
			reasoningEffort: SupportedReasoningEffort;
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
	function getCurrentUserId() {
		return $authState.user?.id ?? null;
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
	const activeThreadQuery = useQuery(api.threads.getByThreadId, () => {
		return currentThreadId && getAuthenticatedQueryArgs() !== 'skip'
			? { threadId: currentThreadId }
			: 'skip';
	});
	const messagesQuery = useQuery(api.messages.listForThread, () => {
		return currentThreadId && getAuthenticatedQueryArgs() !== 'skip'
			? {
					threadId: currentThreadId,
					paginationOpts: { cursor: null, numItems: 40 }
				}
			: 'skip';
	});
	const latestRunQuery = useQuery(api.chat.latestRunForThread, () => {
		return currentThreadId && getAuthenticatedQueryArgs() !== 'skip'
			? { threadId: currentThreadId }
			: 'skip';
	});
	const queryError = $derived.by(() => {
		for (const query of [
			workspaceSessionsQuery,
			threadsQuery,
			uiPreferencesQuery,
			activeThreadQuery,
			messagesQuery,
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
	const currentMessagesData = $derived(dataForThread(messagesQuery.data, currentThreadId));

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
			.filter((thread) => thread.workspaceName === currentWorkspaceName)
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
			runState.submissionId !== undefined &&
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
			if (isSelectionGenerationCurrent(selectionGeneration, workspaceSelectionGeneration)) {
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

	async function handleWorkspaceSelected(overview: WorkspaceOverview) {
		if (!desktopApi || !executorClientId) {
			currentError = localServerRequiredMessage;
			return;
		}
		const pickerUserId = getCurrentUserId();
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

				await attachLocalWorkspaceSession(workspacePickerReconnectSessionId, overview.rootPath);
				if (getCurrentUserId() !== pickerUserId) {
					return;
				}
				setWorkspaceSelection(reconnectSession.workspaceName, currentThreadId);
				currentError = null;
				return;
			}

			const session = await upsertWorkspaceSession({
				workspaceName: overview.name,
				connectedClientId: executorClientId
			});
			if (!session) {
				throw new Error('Failed to create or update the workspace session.');
			}
			if (getCurrentUserId() !== pickerUserId) {
				return;
			}

			await attachLocalWorkspaceSession(session._id, overview.rootPath);
			if (getCurrentUserId() !== pickerUserId) {
				return;
			}
			setWorkspaceSelection(overview.name, null, true);
			currentError = null;
		} catch (error) {
			if (getCurrentUserId() !== pickerUserId) {
				return;
			}
			currentError = error instanceof Error ? error.message : 'Failed to attach workspace.';
			throw error;
		}
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
		reasoningEffort: SupportedReasoningEffort;
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
					reasoningEffort: args.reasoningEffort,
					selectedModel: args.selectedModel,
					submissionId: args.submissionId
				});
			}
		}, agentLaunchTimeoutMs);
	}

	async function createThread(args: {
		isSubmissionCurrent: () => boolean;
		prompt: string;
		selectionGeneration: number;
		selectedModel: SupportedModelId;
		selectedReasoningEffort: SupportedReasoningEffort;
		submissionId: string;
		userId: string;
		workspaceName: string;
		workspaceSessionId: Id<'workspaceSessions'>;
	}) {
		const result = await createThreadMutation({
			submissionId: args.submissionId,
			workspaceSessionId: args.workspaceSessionId,
			selectedModel: args.selectedModel,
			reasoningEffort: args.selectedReasoningEffort
		});
		if (!args.isSubmissionCurrent()) {
			return null;
		}

		if (
			args.userId === getCurrentUserId() &&
			isSelectionGenerationCurrent(args.selectionGeneration, workspaceSelectionGeneration)
		) {
			pendingCreatedThreadId = result.threadId;
			workspaceSelectionGeneration += 1;
			currentThreadId = result.threadId;
			draftWorkspaceName = null;
			schedulePendingCreatedThreadExpiration({
				prompt: args.prompt,
				reasoningEffort: args.selectedReasoningEffort,
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

	async function deleteThread(thread: ThreadSummary) {
		const initialBlockMessage = getThreadDeletionBlockMessage(pendingAgentLaunches, thread);
		if (initialBlockMessage) {
			currentError = initialBlockMessage;
			return;
		}
		const confirmed = window.confirm(
			`Delete "${thread.title}"? This permanently removes the thread, messages, and run history.`
		);
		if (!confirmed) {
			return;
		}
		const currentBlockMessage = getThreadDeletionBlockMessage(pendingAgentLaunches, thread);
		if (currentBlockMessage) {
			currentError = currentBlockMessage;
			return;
		}
		const deletionUserId = getCurrentUserId();

		try {
			await removeThread({ threadId: thread.threadId });
			if (deletionUserId) {
				clearComposerRecovery(deletionUserId, `thread:${thread.threadId}`);
			}
			if (getCurrentUserId() === deletionUserId) {
				if (currentThreadId === thread.threadId) {
					currentThreadId = null;
					pendingCreatedThreadId = null;
					workspaceSelectionGeneration += 1;
				}
				if (lastSavedThreadId === thread.threadId) {
					lastSavedThreadId = null;
				}
				currentError = null;
			}
		} catch (error) {
			if (getCurrentUserId() !== deletionUserId) {
				return;
			}
			currentError = error instanceof Error ? error.message : 'Failed to delete thread.';
		}
	}

	async function submitPrompt() {
		if (isSubmittingPrompt) {
			return;
		}

		if (!prompt.trim()) {
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
		const submittedModel = selectedModel;
		const submittedReasoningEffort = selectedReasoningEffort;
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
			reasoningEffort: submittedReasoningEffort,
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
				reasoningEffort: submittedReasoningEffort,
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
						selectionGeneration,
						selectedModel: submittedModel,
						selectedReasoningEffort: submittedReasoningEffort,
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
				},
				threadId,
				prompt: submittedPrompt,
				selectedModel: submittedModel,
				submissionId: runSubmissionId,
				reasoningEffort: submittedReasoningEffort,
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
			!staleRun.submissionId ||
			!currentLatestRunData?.prompt
		) {
			return;
		}

		const staleClaimKey = `${userId}\0${staleRun._id}\0${staleRun.claimExpiresAt ?? 'none'}`;
		if (recoveredStaleClaims.has(staleClaimKey)) {
			return;
		}
		recoveredStaleClaims.add(staleClaimKey);
		storeComposerRecovery(userId, recoveryScope, {
			message: 'The previous agent stopped responding. Retry to continue this submission.',
			prompt: currentLatestRunData.prompt,
			reasoningEffort: staleRun.reasoningEffort,
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
		workspaceSelectionGeneration += 1;
		prompt = '';
		currentError = null;
		visibleMessages = [];
		elapsedSeconds = 0;
		selectedModel = defaultModelId;
		selectedReasoningEffort = defaultReasoningEffort;
		workspacePickerOpen = false;
		workspacePickerReconnectSessionId = null;
		workspacePickerExpectedName = undefined;
	});

	$effect(() => {
		const data = currentMessagesData;
		if (!data) {
			visibleMessages = [];
			return;
		}

		visibleMessages = [...(data.page ?? [])];
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
		if (prompt === '') {
			prompt = recovery.prompt;
			if (
				recovery.submissionId &&
				recovery.prompt &&
				recovery.reasoningEffort &&
				recovery.selectedModel
			) {
				recoveredSubmissionIds.set(recoveryKey, {
					prompt: recovery.prompt,
					reasoningEffort: recovery.reasoningEffort,
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
		if (hasResolvedInitialSelection) {
			return;
		}

		if (!workspaceSessionsQuery.data || !threadsQuery.data || uiPreferences === undefined) {
			return;
		}

		hasResolvedInitialSelection = true;
		const restoredThread = findThreadById(threads, uiPreferences?.lastThreadId ?? null);
		if (restoredThread) {
			setWorkspaceSelection(restoredThread.workspaceName, restoredThread.threadId);
			restoredWorkspaceSessionIdToAttach =
				findWorkspaceSessionByName(workspaceSessions, restoredThread.workspaceName)?._id ??
				restoredThread.workspaceSessionId;
			lastSavedThreadId = restoredThread.threadId;
			return;
		}

		if (workspaceSessions[0]) {
			setWorkspaceSelection(workspaceSessions[0].workspaceName, null, false);
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
			if (isSelectionGenerationCurrent(selectionGeneration, workspaceSelectionGeneration)) {
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

		void resolveDesktopApi()
			.then(async (client) => {
				desktopApi = client;
				await refreshDesktopWorkspaceSessions();
			})
			.catch((error) => {
				currentError =
					error instanceof Error ? error.message : 'Failed to connect to the Sprocket server.';
			})
			.finally(() => {
				desktopApiResolved = true;
			});
	});
</script>

<svelte:head>
	<title>Sprocket</title>
</svelte:head>

{#if !desktopApiResolved}
	<div
		class="flex h-screen items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.05),transparent_26%),linear-gradient(180deg,rgba(22,22,24,0.98),rgba(15,15,17,1))] px-6"
	>
		<p class="text-sm text-slate-300" aria-live="polite" aria-busy="true">
			Connecting to Sprocket…
		</p>
	</div>
{:else if !desktopApi}
	<div
		class="flex h-screen items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.05),transparent_26%),linear-gradient(180deg,rgba(22,22,24,0.98),rgba(15,15,17,1))] px-6"
	>
		<div
			class="w-full max-w-lg rounded-4xl border border-white/8 bg-[linear-gradient(180deg,rgba(33,33,36,0.96),rgba(24,24,27,0.98))] p-8 shadow-[0_28px_80px_rgba(0,0,0,0.34)]"
		>
			<h1 class="text-2xl font-medium tracking-tight text-white">Connect to Sprocket</h1>
			<p class="mt-3 text-sm leading-6 text-slate-300">
				{currentError ?? 'Connect to your Sprocket server to continue.'}
			</p>
			<a
				class="mt-6 inline-flex rounded-2xl bg-white px-4 py-3 text-sm font-medium text-black transition hover:bg-slate-100"
				href={resolve('/pair')}
			>
				Open pairing
			</a>
		</div>
	</div>
{:else if !authReady}
	<div
		class="h-screen overflow-hidden bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.05),transparent_26%),linear-gradient(180deg,rgba(22,22,24,0.98),rgba(15,15,17,1))]"
	>
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
				onSignOut={() => void signOut()}
				onStartThreadDraft={(workspaceName) => {
					void startThreadDraftForWorkspace(workspaceName);
				}}
				onSelectThread={(thread) => {
					void selectThread(thread);
				}}
				onDeleteThread={(thread) => {
					void deleteThread(thread);
				}}
			/>

			<main class="flex h-screen min-h-0 min-w-0 flex-col overflow-hidden">
				<header class="flex h-12 items-center justify-between border-b border-white/6 px-5">
					<div class="flex min-w-0 items-center gap-3">
						<h1 class="truncate text-[1rem] font-medium tracking-[-0.03em] text-white">
							{currentActiveThread?.title ?? 'New thread'}
						</h1>
						{#if currentWorkspaceSession}
							<span
								class="truncate rounded-full border border-white/8 bg-white/3 px-2.5 py-0.5 text-[11px] text-slate-300"
							>
								{currentWorkspaceSession.workspaceName}
							</span>
						{/if}
					</div>

					<div class="flex items-center gap-2">
						{#if currentWorkspaceSession}
							<button
								type="button"
								class="rounded-full border border-white/8 bg-white/3 px-3.5 py-1.5 text-[13px] text-slate-200 transition hover:border-white/12 hover:bg-white/6 hover:text-white"
								onclick={() => {
									if (currentWorkspaceSession.localWorkspaceAvailability === 'available') {
										openWorkspacePicker('add');
										return;
									}

									reconnectWorkspaceSession(currentWorkspaceSession._id);
								}}
							>
								{currentWorkspaceSession.localWorkspaceAvailability === 'available'
									? 'Open'
									: 'Reconnect'}
							</button>
						{/if}
					</div>
				</header>

				<ThreadTranscript
					currentError={currentError ?? $authState.error ?? queryError?.message ?? null}
					runError={runState?.lastError ?? null}
					messages={visibleMessages}
					actions={visibleActions}
					workspaceSession={currentWorkspaceSession}
				/>

				<PromptComposer
					bind:prompt
					bind:selectedModel
					bind:selectedReasoningEffort
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
				onSelect={async (overview) => {
					try {
						await handleWorkspaceSelected(overview);
					} catch {
						await refreshDesktopWorkspaceSessions();
					}
				}}
			/>
		{/if}
	</div>
{/if}
