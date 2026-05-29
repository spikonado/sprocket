<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { PUBLIC_CONVEX_URL } from '$env/static/public';
	import { useConvexClient, useQuery } from 'convex-svelte';
	import type { Id } from '$convex/_generated/dataModel';
	import { api } from '$convex/_generated/api';
	import { EXECUTOR_HEARTBEAT_WRITE_THROTTLE_MS } from '$convex/lib/workspaceConnection';
	import { authState, getAccessToken, signIn, signOut } from '$lib/auth';
	import PromptComposer from '$lib/components/home/prompt-composer.svelte';
	import ThreadTranscript from '$lib/components/home/thread-transcript.svelte';
	import WorkspacePicker from '$lib/components/home/workspace-picker.svelte';
	import WorkspaceSidebar from '$lib/components/home/workspace-sidebar.svelte';
	import {
		attachLocalWorkspaceSession as attachLocalWorkspaceSessionForPath,
		attachWorkspaceSession as attachWorkspaceSessionForExecution,
		getViewerArgs as getViewerArgsForUser,
		launchAgentRun,
		refreshDesktopWorkspaceSessions as refreshDesktopWorkspaceSessionsFromDesktop,
		syncAttachedWorkspaceSessions as syncAttachedWorkspaceSessionsForClient,
		type WorkspaceSelectionResult,
		type WorkspaceSessionState
	} from '$lib/home/desktop';
	import { formatElapsedDuration } from '$lib/format';
	import {
		defaultModelId,
		defaultReasoningEffort,
		type SupportedModelId,
		type SupportedReasoningEffort
	} from '$lib/chat/models';
	import {
		getAttachedWorkspaceSessionIds,
		getWorkspaceThreadGroups,
		findThreadById,
		findWorkspaceSessionByName,
		resolveWorkspaceThreadSelection
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

	const convexClient = useConvexClient();
	const localServerRequiredMessage = 'Connect to a running Sprocket server to use this workspace.';
	const guestSessionIdPattern =
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

	let desktopApi = $state<DesktopApi | null>(null);
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
	let guestSessionId = $state<string | null>(null);
	let isSubmittingPrompt = $state(false);
	let hasPendingAgentLaunch = $state(false);
	let pendingLaunchPreviousRunId = $state<Id<'runs'> | null>(null);
	let hasResolvedInitialSelection = $state(false);
	let restoredWorkspaceSessionIdToAttach = $state<Id<'workspaceSessions'> | null>(null);
	let lastSavedThreadId = $state<Id<'threadRecords'> | null>(null);
	let desktopWorkspaceSessionsById = $state<Record<string, WorkspaceSessionLocation>>({});
	let workspacePickerOpen = $state(false);
	let workspacePickerMode = $state<'add' | 'reconnect'>('add');
	let workspacePickerExpectedName = $state<string | undefined>(undefined);
	let workspacePickerReconnectSessionId = $state<Id<'workspaceSessions'> | null>(null);
	function getViewerArgs() {
		return getViewerArgsForUser($authState.user, guestSessionId);
	}

	const workspaceSessionsQuery = useQuery(api.workspaceSessions.listMine, () =>
		$authState.user ? {} : guestSessionId ? { guestId: guestSessionId } : 'skip'
	);
	const threadsQuery = useQuery(api.threads.listMine, () =>
		$authState.user ? {} : guestSessionId ? { guestId: guestSessionId } : 'skip'
	);
	const uiPreferencesQuery = useQuery(api.uiPreferences.getMine, () =>
		$authState.user ? {} : guestSessionId ? { guestId: guestSessionId } : 'skip'
	);
	const activeThreadQuery = useQuery(api.threads.getByThreadId, () =>
		currentThreadId
			? $authState.user
				? { threadId: currentThreadId }
				: guestSessionId
					? { guestId: guestSessionId, threadId: currentThreadId }
					: 'skip'
			: 'skip'
	);
	const messagesQuery = useQuery(api.messages.listForThread, () =>
		currentThreadId
			? {
					...(!$authState.user && guestSessionId ? { guestId: guestSessionId } : {}),
					threadId: currentThreadId,
					paginationOpts: { cursor: null, numItems: 40 }
				}
			: 'skip'
	);
	const latestRunQuery = useQuery(api.chat.latestRunForThread, () =>
		currentThreadId
			? $authState.user
				? { threadId: currentThreadId }
				: guestSessionId
					? { guestId: guestSessionId, threadId: currentThreadId }
					: 'skip'
			: 'skip'
	);
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

	const runState = $derived(latestRunQuery.data?.run);
	const visibleActions = $derived((latestRunQuery.data?.jobs ?? []).slice(-60));
	const isRunning = $derived(
		runState?.status === 'queued' ||
			runState?.status === 'running' ||
			runState?.status === 'awaiting_executor'
	);
	const canSend = $derived(
		Boolean(
			currentWorkspaceSessionId &&
			currentWorkspaceSession?.localWorkspaceAvailability === 'available' &&
			!isRunning &&
			!isSubmittingPrompt &&
			!hasPendingAgentLaunch
		)
	);
	const attachedWorkspaceSessionIds = $derived.by<Id<'workspaceSessions'>[]>(() =>
		getAttachedWorkspaceSessionIds(workspaceSessions, executorClientId)
	);
	const attachedWorkspaceSessionIdsKey = $derived.by(() =>
		[...attachedWorkspaceSessionIds].sort().join('\0')
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
		desktopWorkspaceSessionsById = await refreshDesktopWorkspaceSessionsFromDesktop(desktopApi);
	}

	function setWorkspaceSelection(
		workspaceName: string,
		threadId: Id<'threadRecords'> | null = null,
		draft: boolean = false
	) {
		currentWorkspaceName = workspaceName;
		currentThreadId = threadId;
		draftWorkspaceName = draft ? workspaceName : null;
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
		desktopWorkspaceSessionsById = {
			...desktopWorkspaceSessionsById,
			[session.workspaceSessionId]: session
		};
		return session;
	}

	async function syncAttachedWorkspaceSessions(workspaceSessionIds: Id<'workspaceSessions'>[]) {
		await syncAttachedWorkspaceSessionsForClient({
			attachedWorkspaceSessionIds,
			convexClient,
			executorClientId,
			getViewerArgs,
			workspaceSessionIds
		});
	}

	async function openWorkspaceSession(
		workspaceName: string,
		selection: { threadId?: Id<'threadRecords'> | null; draft?: boolean } = {}
	) {
		const workspaceSession = findWorkspaceSessionByName(workspaceSessions, workspaceName);
		if (!workspaceSession) {
			currentError = 'Choose a workspace first.';
			return;
		}

		await attachWorkspaceSession(workspaceSession._id);
		setWorkspaceSelection(workspaceName, selection.threadId, selection.draft);
		currentError = null;
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
				await attachWorkspaceSession(workspacePickerReconnectSessionId);
				setWorkspaceSelection(reconnectSession.workspaceName, currentThreadId);
				currentError = null;
				return;
			}

			const session = (await convexClient.mutation(api.workspaceSessions.upsertSelected, {
				...getViewerArgs(),
				workspaceName: overview.name,
				connectedClientId: executorClientId
			})) as WorkspaceSelectionResult;
			await attachLocalWorkspaceSession(session._id, overview.rootPath);
			await syncAttachedWorkspaceSessions([session._id]);
			setWorkspaceSelection(overview.name, null, true);
			currentError = null;
		} catch (error) {
			currentError = error instanceof Error ? error.message : 'Failed to attach workspace.';
			throw error;
		}
	}

	async function attachWorkspaceSession(workspaceSessionId: Id<'workspaceSessions'>) {
		await attachWorkspaceSessionForExecution({
			attachedWorkspaceSessionIds,
			convexClient,
			desktopApi,
			executorClientId,
			getViewerArgs,
			refreshDesktopWorkspaceSessions,
			workspaceSessionId
		});
	}

	function reconnectWorkspaceSession(workspaceSessionId: Id<'workspaceSessions'>) {
		openWorkspacePicker('reconnect', workspaceSessionId);
	}

	async function createThread() {
		const workspaceSessionId = currentWorkspaceSessionId;
		if (!workspaceSessionId) {
			currentError = 'Choose a workspace first.';
			return null;
		}

		const result = await convexClient.mutation(api.threads.create, {
			...getViewerArgs(),
			workspaceSessionId,
			selectedModel,
			reasoningEffort: selectedReasoningEffort
		});
		currentThreadId = result.threadId;
		draftWorkspaceName = null;
		return result.threadId;
	}

	async function startThreadDraftForWorkspace(workspaceName: string) {
		try {
			await openWorkspaceSession(workspaceName, { draft: true });
			return null;
		} catch (error) {
			currentError = error instanceof Error ? error.message : 'Failed to open thread draft.';
			return null;
		}
	}

	async function selectThread(thread: ThreadSummary) {
		try {
			await openWorkspaceSession(thread.workspaceName, { threadId: thread.threadId });
		} catch (error) {
			currentError = error instanceof Error ? error.message : 'Failed to attach workspace.';
		}
	}

	async function deleteThread(thread: ThreadSummary) {
		if (thread.hasActiveRun) {
			currentError = 'Finish or cancel the active run before deleting this thread.';
			return;
		}

		const confirmed = window.confirm(
			`Delete "${thread.title}"? This permanently removes the thread, messages, and run history.`
		);
		if (!confirmed) {
			return;
		}

		try {
			await convexClient.mutation(api.threads.remove, {
				...getViewerArgs(),
				threadId: thread.threadId
			});
			if (currentThreadId === thread.threadId) {
				currentThreadId = null;
			}
			if (lastSavedThreadId === thread.threadId) {
				lastSavedThreadId = null;
			}
			currentError = null;
		} catch (error) {
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

		if (!currentWorkspaceSessionId) {
			currentError = 'Choose a workspace first.';
			return;
		}

		if (!desktopApi) {
			currentError = localServerRequiredMessage;
			return;
		}

		if (!canSend) {
			currentError =
				currentWorkspaceSession?.localWorkspaceAvailability === 'available'
					? 'You need an active workspace session before sending.'
					: 'This workspace needs to be attached before sending.';
			return;
		}

		isSubmittingPrompt = true;

		try {
			await attachWorkspaceSession(currentWorkspaceSessionId);
			const threadId = currentThreadId ?? (await createThread());
			if (!threadId) {
				return;
			}

			const nextPrompt = prompt.trim();
			prompt = '';
			currentError = null;
			const authToken = $authState.user ? ((await getAccessToken()) ?? undefined) : undefined;
			hasPendingAgentLaunch = true;
			pendingLaunchPreviousRunId = runState?._id ?? null;
			launchAgentRun({
				authToken,
				desktopApi,
				deploymentUrl: PUBLIC_CONVEX_URL,
				getViewerArgs,
				onError: (error) => {
					hasPendingAgentLaunch = false;
					pendingLaunchPreviousRunId = null;
					currentError =
						error instanceof Error ? error.message : 'Failed to start the local agent run.';
				},
				threadId,
				prompt: nextPrompt,
				selectedModel,
				reasoningEffort: selectedReasoningEffort,
				workspaceSessionId: currentWorkspaceSessionId
			});
		} catch (error) {
			await refreshDesktopWorkspaceSessions();
			currentError = error instanceof Error ? error.message : 'Failed to send prompt.';
		} finally {
			isSubmittingPrompt = false;
		}
	}

	async function cancelRun() {
		if (!runState?._id || !isRunning) {
			return;
		}

		try {
			await convexClient.mutation(api.agentRuntime.finishRun, {
				...getViewerArgs(),
				runId: runState._id,
				status: 'cancelled'
			});
		} catch (error) {
			currentError = error instanceof Error ? error.message : 'Failed to cancel run.';
		}
	}

	$effect(() => {
		const data = messagesQuery.data;
		if (!data) {
			visibleMessages = [];
			return;
		}

		visibleMessages = [...(data.page ?? [])];
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
		}
	});

	$effect(() => {
		const workspaceSessionId = restoredWorkspaceSessionIdToAttach;
		if (!workspaceSessionId || !desktopApi || !executorClientId) {
			return;
		}

		const workspaceSession = workspaceSessions.find(
			(session) => session._id === workspaceSessionId
		);
		if (!workspaceSession || workspaceSession.localWorkspaceAvailability !== 'available') {
			restoredWorkspaceSessionIdToAttach = null;
			if (workspaceSession?.localWorkspaceError) {
				currentError = workspaceSession.localWorkspaceError;
			}
			return;
		}

		restoredWorkspaceSessionIdToAttach = null;
		void attachWorkspaceSession(workspaceSessionId).catch((error) => {
			void refreshDesktopWorkspaceSessions();
			currentError = error instanceof Error ? error.message : 'Failed to attach workspace.';
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
			draftWorkspaceName
		});
		if (nextThreadId === currentThreadId) {
			return;
		}

		currentThreadId = nextThreadId;
	});

	$effect(() => {
		if (!hasResolvedInitialSelection || !currentThreadId) {
			return;
		}

		if (currentThreadId === lastSavedThreadId) {
			return;
		}

		lastSavedThreadId = currentThreadId;
		void convexClient.mutation(api.uiPreferences.setLastThread, {
			...getViewerArgs(),
			threadId: currentThreadId
		});
	});

	$effect(() => {
		const startedAt = runState?.startedAt;
		if (hasPendingAgentLaunch && runState?._id && runState._id !== pendingLaunchPreviousRunId) {
			hasPendingAgentLaunch = false;
			pendingLaunchPreviousRunId = null;
		}
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
		const workspaceSessionIdsKey = attachedWorkspaceSessionIdsKey;
		const workspaceSessionIds = workspaceSessionIdsKey
			? (workspaceSessionIdsKey.split('\0') as Id<'workspaceSessions'>[])
			: [];
		if (!clientId || !desktopApi || workspaceSessionIds.length === 0) {
			return;
		}

		void convexClient.mutation(api.workspaceSessions.heartbeatAttached, {
			...getViewerArgs(),
			clientId,
			workspaceSessionIds
		});

		const intervalId = window.setInterval(() => {
			void convexClient.mutation(api.workspaceSessions.heartbeatAttached, {
				...getViewerArgs(),
				clientId,
				workspaceSessionIds
			});
		}, EXECUTOR_HEARTBEAT_WRITE_THROTTLE_MS);

		return () => {
			window.clearInterval(intervalId);
		};
	});

	onMount(() => {
		executorClientId = crypto.randomUUID();
		const persistedGuestSessionId: string | null = localStorage.getItem(
			'sprocket.guest-session-id'
		);
		const nextGuestSessionId: string =
			persistedGuestSessionId && guestSessionIdPattern.test(persistedGuestSessionId)
				? persistedGuestSessionId
				: crypto.randomUUID();
		guestSessionId = nextGuestSessionId;
		if (nextGuestSessionId !== persistedGuestSessionId) {
			localStorage.setItem('sprocket.guest-session-id', nextGuestSessionId);
		}

		void resolveDesktopApi()
			.then(async (client) => {
				desktopApi = client;
				await refreshDesktopWorkspaceSessions();
			})
			.catch((error) => {
				currentError =
					error instanceof Error ? error.message : 'Failed to connect to the Sprocket server.';
			});
	});
</script>

<svelte:head>
	<title>Sprocket</title>
</svelte:head>

{#if !desktopApi}
	<div
		class="flex h-screen items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.05),transparent_26%),linear-gradient(180deg,rgba(22,22,24,0.98),rgba(15,15,17,1))] px-6"
	>
		<div
			class="w-full max-w-lg rounded-4xl border border-white/8 bg-[linear-gradient(180deg,rgba(33,33,36,0.96),rgba(24,24,27,0.98))] p-8 shadow-[0_28px_80px_rgba(0,0,0,0.34)]"
		>
			<h1 class="mt-3 text-2xl font-medium tracking-tight text-white">Connect to Sprocket</h1>
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
{:else}
	<div class="h-screen overflow-hidden">
		<div
			class="grid h-screen grid-cols-[292px_minmax(0,1fr)] overflow-hidden bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.05),transparent_26%),linear-gradient(180deg,rgba(22,22,24,0.98),rgba(15,15,17,1))]"
		>
			<WorkspaceSidebar
				isAuthenticated={Boolean($authState.user)}
				{currentWorkspaceName}
				{currentThreadId}
				groups={groupedWorkspaceThreads}
				onChooseWorkspace={() => {
					openWorkspacePicker('add');
				}}
				onReconnectWorkspace={(workspaceSessionId) => {
					void reconnectWorkspaceSession(workspaceSessionId);
				}}
				onAccountAction={() => {
					if ($authState.user) {
						void signOut();
						return;
					}
					void signIn();
				}}
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
							{activeThreadQuery.data?.title ?? 'New thread'}
						</h1>
						{#if currentWorkspaceSession}
							<span
								class="truncate rounded-full border border-white/8 bg-white/3 px-2.5 py-0.5 text-[11px] text-slate-300"
							>
								{currentWorkspaceSession.workspaceName}
							</span>
						{/if}
						{#if !$authState.user}
							<span
								class="truncate rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-0.5 text-[11px] text-amber-100"
							>
								Guest session
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
					currentError={currentError ?? $authState.error}
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
					isSubmitting={isSubmittingPrompt}
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
