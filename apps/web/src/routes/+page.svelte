<script lang="ts">
	import { onMount } from 'svelte';
	import { PUBLIC_CONVEX_URL } from '$env/static/public';
	import { useConvexClient, useQuery } from 'convex-svelte';
	import type { Id } from '$convex/_generated/dataModel';
	import { api } from '$convex/_generated/api';
	import { EXECUTOR_HEARTBEAT_WRITE_THROTTLE_MS } from '$convex/lib/workspaceConnection';
	import { authState, getAccessToken, signIn, signOut } from '$lib/auth';
	import PromptComposer from '$lib/components/home/prompt-composer.svelte';
	import ThreadTranscript from '$lib/components/home/thread-transcript.svelte';
	import WorkspaceSidebar from '$lib/components/home/workspace-sidebar.svelte';
	import {
		defaultModelId,
		defaultReasoningEffort,
		type SupportedModelId,
		type SupportedReasoningEffort
	} from '$lib/models';
	import {
		getAttachedWorkspaceSessionIds,
		getWorkspaceThreadGroups,
		getWorkspaceSessionLookup,
		groupExecutorJobsByWorkspace,
		pickNextExecutorJobForWorkspace
	} from '$lib/executor-coordinator';
	import { findThreadById, resolveWorkspaceThreadSelection } from '$lib/thread-selection';
	import type {
		DesktopApi,
		ExecutorJob,
		ThreadMessage,
		ThreadSummary,
		WorkspaceSession,
		WorkspaceThreadGroup,
		WorkspaceToolRequest,
		WorkspaceOverview
	} from '$lib/types/sprocket';

	const guestStorageKey = 'sprocket.guest-session-id';
	const convexClient = useConvexClient();

	let desktopApi = $state<DesktopApi | null>(null);
	let currentWorkspaceSessionId = $state<Id<'workspaceSessions'> | null>(null);
	let currentThreadId = $state<string | null>(null);
	let draftWorkspaceSessionId = $state<Id<'workspaceSessions'> | null>(null);
	let selectedModel = $state<SupportedModelId>(defaultModelId);
	let selectedReasoningEffort = $state<SupportedReasoningEffort>(defaultReasoningEffort);
	let prompt = $state('');
	let currentError = $state<string | null>(null);
	let executorClientId = $state<string | null>(null);
	let visibleMessages = $state<ThreadMessage[]>([]);
	let elapsedSeconds = $state(0);
	let guestSessionId = $state<string | null>(null);
	let hasResolvedInitialSelection = $state(false);
	let restoredWorkspaceSessionIdToAttach = $state<Id<'workspaceSessions'> | null>(null);
	let lastSavedThreadId = $state<string | null>(null);
	let processingJobIdsByWorkspace: Record<string, Id<'executorJobs'>> = {};
	let executorProcessing = false;
	let executorProcessQueued = false;

	function getViewerArgs() {
		return !$authState.user && guestSessionId ? { guestId: guestSessionId } : {};
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
	const pendingJobsForClientQuery = useQuery(api.executor.listPendingForClient, () =>
		executorClientId
			? $authState.user
				? { clientId: executorClientId }
				: guestSessionId
					? { guestId: guestSessionId, clientId: executorClientId }
					: 'skip'
			: 'skip'
	);

	const workspaceSessions = $derived((workspaceSessionsQuery.data ?? []) as WorkspaceSession[]);
	const threads = $derived((threadsQuery.data ?? []) as ThreadSummary[]);

	const currentWorkspaceSession = $derived.by<WorkspaceSession | null>(() => {
		if (!currentWorkspaceSessionId) {
			return null;
		}

		return workspaceSessions.find((session) => session._id === currentWorkspaceSessionId) ?? null;
	});

	const currentWorkspaceThreads = $derived.by<ThreadSummary[]>(() => {
		if (!currentWorkspaceSessionId) {
			return [];
		}

		return threads
			.filter((thread) => thread.workspaceSessionId === currentWorkspaceSessionId)
			.sort((left, right) => right.lastMessageAt - left.lastMessageAt);
	});

	const groupedWorkspaceThreads = $derived.by<WorkspaceThreadGroup[]>(() =>
		getWorkspaceThreadGroups(workspaceSessions, threads)
	);

	const runState = $derived(latestRunQuery.data);
	const visibleActions = $derived((runState?.jobs ?? []).slice(-60));
	const isRunning = $derived(
		runState?.status === 'queued' ||
			runState?.status === 'running' ||
			runState?.status === 'awaiting_executor'
	);
	const canSend = $derived(Boolean(currentWorkspaceSessionId && desktopApi && !isRunning));
	const attachedWorkspaceSessionIds = $derived.by<Id<'workspaceSessions'>[]>(() =>
		getAttachedWorkspaceSessionIds(workspaceSessions, executorClientId)
	);
	const attachedWorkspaceSessionIdsKey = $derived.by(() =>
		[...attachedWorkspaceSessionIds].sort().join('\0')
	);
	const workspaceSessionLookup = $derived.by(() => getWorkspaceSessionLookup(workspaceSessions));

	function resolveDesktopApi() {
		return window.sprocketDesktop ?? null;
	}

	function executorRequest(
		workspaceRoot: string,
		request: Omit<WorkspaceToolRequest, 'workspaceRoot'>
	): WorkspaceToolRequest {
		return {
			...request,
			workspaceRoot
		} as WorkspaceToolRequest;
	}

	function setWorkspaceSelection(args: {
		workspaceSessionId: Id<'workspaceSessions'>;
		threadId?: string | null;
		draft?: boolean;
	}) {
		const { workspaceSessionId, threadId = null, draft = false } = args;
		currentWorkspaceSessionId = workspaceSessionId;
		currentThreadId = threadId;
		draftWorkspaceSessionId = draft ? workspaceSessionId : null;
	}

	function getWorkspaceSessionOrThrow(workspaceSessionId: Id<'workspaceSessions'>) {
		const workspaceSession = workspaceSessionLookup.get(workspaceSessionId);
		if (!workspaceSession) {
			throw new Error('Workspace session not found.');
		}

		return workspaceSession;
	}

	async function openWorkspaceSession(
		workspaceSessionId: Id<'workspaceSessions'>,
		selection: { threadId?: string | null; draft?: boolean } = {}
	) {
		await attachWorkspaceSession(workspaceSessionId);
		setWorkspaceSelection({ workspaceSessionId, ...selection });
		currentError = null;
	}

	async function chooseWorkspace() {
		if (!desktopApi || !executorClientId) {
			currentError = 'Workspace selection is only available in the desktop app.';
			return;
		}

		try {
			const workspaceRoot = await desktopApi.chooseWorkspace();
			if (!workspaceRoot) {
				return;
			}

			const overview = (await desktopApi.executeWorkspaceTool(
				executorRequest(workspaceRoot, {
					toolName: 'get_workspace_overview',
					payload: {}
				})
			)) as WorkspaceOverview;
			const session = (await convexClient.mutation(api.workspaceSessions.upsertSelected, {
				...getViewerArgs(),
				workspacePath: workspaceRoot,
				workspaceOverview: overview,
				connectedClientId: executorClientId
			})) as WorkspaceSession;
			setWorkspaceSelection({ workspaceSessionId: session._id, draft: true });
			currentError = null;
		} catch (error) {
			currentError = error instanceof Error ? error.message : 'Failed to attach workspace.';
		}
	}

	async function attachWorkspaceSession(workspaceSessionId: Id<'workspaceSessions'>) {
		if (!desktopApi || !executorClientId) {
			return;
		}

		const workspaceSession = getWorkspaceSessionOrThrow(workspaceSessionId);

		const overview = (await desktopApi.executeWorkspaceTool(
			executorRequest(workspaceSession.workspacePath, {
				toolName: 'get_workspace_overview',
				payload: {}
			})
		)) as WorkspaceOverview;

		await convexClient.mutation(api.workspaceSessions.upsertSelected, {
			...getViewerArgs(),
			workspacePath: workspaceSession.workspacePath,
			workspaceOverview: overview,
			connectedClientId: executorClientId
		});
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
		draftWorkspaceSessionId = null;
		return result.threadId;
	}

	async function startThreadDraftForWorkspace(workspaceSessionId: Id<'workspaceSessions'>) {
		try {
			await openWorkspaceSession(workspaceSessionId, { draft: true });
			return null;
		} catch (error) {
			currentError = error instanceof Error ? error.message : 'Failed to open thread draft.';
			return null;
		}
	}

	async function selectThread(thread: ThreadSummary) {
		try {
			await openWorkspaceSession(thread.workspaceSessionId, { threadId: thread.threadId });
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
		if (!prompt.trim()) {
			return;
		}

		if (!currentWorkspaceSessionId) {
			currentError = 'Choose a workspace first.';
			return;
		}

		if (!desktopApi) {
			currentError = 'Desktop executor required to send new prompts for this workspace.';
			return;
		}

		if (!canSend) {
			currentError = 'You need an active workspace session before sending.';
			return;
		}

		try {
			await attachWorkspaceSession(currentWorkspaceSessionId);
			const threadId = currentThreadId ?? (await createThread());
			if (!threadId) {
				return;
			}

			const nextPrompt = prompt.trim();
			prompt = '';
			currentError = null;
			const { runId } = (await convexClient.mutation(api.chat.send, {
				...getViewerArgs(),
				threadId,
				prompt: nextPrompt,
				selectedModel,
				reasoningEffort: selectedReasoningEffort
			})) as { runId: string };
			const authToken = $authState.user ? ((await getAccessToken()) ?? undefined) : undefined;
			try {
				await desktopApi.runAgent({
					deploymentUrl: PUBLIC_CONVEX_URL,
					...(authToken ? { authToken } : {}),
					...getViewerArgs(),
					runId
				});
			} catch (error) {
				console.error('Failed to run agent', error);
				currentError = null;
			}
		} catch (error) {
			currentError = error instanceof Error ? error.message : 'Failed to send prompt.';
		}
	}

	async function cancelRun() {
		if (!runState?._id || !isRunning) {
			return;
		}

		try {
			await convexClient.mutation(api.chat.cancel, {
				...getViewerArgs(),
				runId: runState._id
			});
		} catch (error) {
			currentError = error instanceof Error ? error.message : 'Failed to cancel run.';
		}
	}

	function formatElapsedDuration(totalSeconds: number) {
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;

		if (minutes === 0) {
			return `${seconds}s`;
		}

		return `${minutes}m ${seconds}s`;
	}

	function setProcessingJobForWorkspace(
		workspaceSessionId: Id<'workspaceSessions'>,
		jobId: Id<'executorJobs'> | null
	) {
		if (jobId) {
			processingJobIdsByWorkspace[workspaceSessionId] = jobId;
		} else {
			delete processingJobIdsByWorkspace[workspaceSessionId];
		}
	}

	async function processExecutorJobs() {
		if (!desktopApi || !executorClientId) {
			return;
		}

		const jobs = (pendingJobsForClientQuery.data ?? []) as ExecutorJob[];
		const jobsByWorkspace = groupExecutorJobsByWorkspace(jobs);

		for (const [workspaceSessionId, processingJobId] of Object.entries(
			processingJobIdsByWorkspace
		) as [Id<'workspaceSessions'>, Id<'executorJobs'>][]) {
			const workspaceJobs = jobsByWorkspace.get(workspaceSessionId) ?? [];
			const stillVisible = workspaceJobs.some((job) => job._id === processingJobId);
			if (stillVisible) {
				continue;
			}

			setProcessingJobForWorkspace(workspaceSessionId, null);
		}

		for (const [workspaceSessionId, workspaceJobs] of jobsByWorkspace) {
			if (processingJobIdsByWorkspace[workspaceSessionId]) {
				continue;
			}

			const nextJob = pickNextExecutorJobForWorkspace(workspaceJobs, executorClientId);
			if (!nextJob) {
				continue;
			}

			setProcessingJobForWorkspace(workspaceSessionId, nextJob._id);

			void (async () => {
				try {
					const claimedJob = (await convexClient.mutation(api.executor.claim, {
						...getViewerArgs(),
						jobId: nextJob._id,
						clientId: executorClientId
					})) as ExecutorJob | null;
					if (!claimedJob) {
						return;
					}

					const workspaceSession = getWorkspaceSessionOrThrow(claimedJob.workspaceSessionId);

					const result = await desktopApi.executeWorkspaceTool(
						executorRequest(workspaceSession.workspacePath, {
							jobId: claimedJob._id,
							toolName: claimedJob.kind,
							payload: claimedJob.payload as WorkspaceToolRequest['payload']
						})
					);
					await convexClient.mutation(api.executor.complete, {
						...getViewerArgs(),
						jobId: claimedJob._id,
						result
					});
				} catch (error) {
					await convexClient.mutation(api.executor.fail, {
						...getViewerArgs(),
						jobId: nextJob._id,
						error: error instanceof Error ? error.message : 'Executor job failed.'
					});
				} finally {
					setProcessingJobForWorkspace(workspaceSessionId, null);
				}
			})();
		}
	}

	async function processExecutorJobsSafely() {
		if (executorProcessing) {
			executorProcessQueued = true;
			return;
		}

		executorProcessing = true;
		try {
			do {
				executorProcessQueued = false;
				await processExecutorJobs();
			} while (executorProcessQueued);
		} finally {
			executorProcessing = false;
		}
	}

	$effect(() => {
		const data = messagesQuery.data;
		if (!data) {
			visibleMessages = [];
			return;
		}

		visibleMessages = [...(data.page ?? [])].sort((left, right) => {
			if (left.order !== right.order) {
				return left.order - right.order;
			}
			return left.stepOrder - right.stepOrder;
		});
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
			setWorkspaceSelection({
				workspaceSessionId: restoredThread.workspaceSessionId,
				threadId: restoredThread.threadId
			});
			restoredWorkspaceSessionIdToAttach = restoredThread.workspaceSessionId;
			lastSavedThreadId = restoredThread.threadId;
			return;
		}

		if (workspaceSessions[0]) {
			setWorkspaceSelection({ workspaceSessionId: workspaceSessions[0]._id });
		}
	});

	$effect(() => {
		const workspaceSessionId = restoredWorkspaceSessionIdToAttach;
		if (!workspaceSessionId || !desktopApi || !executorClientId) {
			return;
		}

		restoredWorkspaceSessionIdToAttach = null;
		void attachWorkspaceSession(workspaceSessionId).catch((error) => {
			currentError = error instanceof Error ? error.message : 'Failed to attach workspace.';
		});
	});

	$effect(() => {
		const activeThread = activeThreadQuery.data;
		if (
			activeThread?.workspaceSessionId &&
			activeThread.workspaceSessionId !== currentWorkspaceSessionId
		) {
			setWorkspaceSelection({
				workspaceSessionId: activeThread.workspaceSessionId,
				threadId: currentThreadId,
				draft: draftWorkspaceSessionId === activeThread.workspaceSessionId
			});
		}
	});

	$effect(() => {
		const threads = currentWorkspaceThreads;
		if (!hasResolvedInitialSelection || !currentWorkspaceSessionId) {
			return;
		}

		const nextThreadId = resolveWorkspaceThreadSelection({
			threads,
			currentThreadId,
			currentWorkspaceSessionId,
			draftWorkspaceSessionId
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

	$effect(() => {
		void processExecutorJobsSafely();
	});

	onMount(() => {
		desktopApi = resolveDesktopApi();
		executorClientId = crypto.randomUUID();
		const persistedGuestSessionId = localStorage.getItem(guestStorageKey);
		guestSessionId = persistedGuestSessionId || crypto.randomUUID();
		if (!persistedGuestSessionId) {
			localStorage.setItem(guestStorageKey, guestSessionId);
		}
	});
</script>

<svelte:head>
	<title>Sprocket</title>
</svelte:head>

<div class="h-screen overflow-hidden">
	<div
		class="grid h-screen grid-cols-[292px_minmax(0,1fr)] overflow-hidden bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.05),transparent_26%),linear-gradient(180deg,rgba(22,22,24,0.98),rgba(15,15,17,1))]"
	>
		<WorkspaceSidebar
			isAuthenticated={Boolean($authState.user)}
			desktopAvailable={Boolean(desktopApi)}
			{currentWorkspaceSessionId}
			{currentThreadId}
			groups={groupedWorkspaceThreads}
			onChooseWorkspace={chooseWorkspace}
			onAccountAction={() => {
				if ($authState.user) {
					void signOut();
					return;
				}
				void signIn();
			}}
			onStartThreadDraft={(workspaceSessionId) => {
				void startThreadDraftForWorkspace(workspaceSessionId);
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
							class="rounded-full border border-white/8 bg-white/3 px-3.5 py-1.5 text-[13px] text-slate-200 transition hover:border-white/12 hover:bg-white/6 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
							onclick={chooseWorkspace}
							disabled={!desktopApi}
						>
							Open
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
				desktopAvailable={Boolean(desktopApi)}
			/>

			<PromptComposer
				bind:prompt
				bind:selectedModel
				bind:selectedReasoningEffort
				workspaceSession={currentWorkspaceSession}
				{canSend}
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
</div>
