<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { page } from '$app/state';
	import { PanelRight } from '@lucide/svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { useAuth, useMutation, useQuery } from 'convex-svelte';
	import type { Doc, Id } from '$convex/_generated/dataModel';
	import { api } from '$convex/_generated/api';
	import {
		advanceConvexAuthRetryPending,
		authState,
		cancelDesktopSignIn,
		clearDesktopSignInOpenError,
		convexAuthRetryPending,
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
	import SettingsArchived from '$lib/components/home/settings-archived.svelte';
	import SettingsPayments from '$lib/components/home/settings-payments.svelte';
	import SettingsSidebar, { type SettingsPage } from '$lib/components/home/settings-sidebar.svelte';
	import SettingsUsage from '$lib/components/home/settings-usage.svelte';
	import ThreadTranscript from '$lib/components/home/thread-transcript.svelte';
	import SidePanel from '$lib/components/home/side-panel.svelte';
	import ArtifactScreenFullscreen from '$lib/components/home/artifact-screen-fullscreen.svelte';
	import { nextArtifactRevisionWatch, type ArtifactRevision } from '$lib/chat/artifacts';
	import { DEFAULT_SIDE_PANEL_SNAPSHOT, type SidePanelSnapshot } from '$lib/chat/side-panel';
	import ProjectPicker, { type ProjectSelection } from '$lib/components/home/project-picker.svelte';
	import ProjectSidebar from '$lib/components/home/project-sidebar.svelte';
	import Button from '$lib/components/ui/button/button.svelte';
	import {
		attachLocalProject as attachLocalProjectForPath,
		launchAgentRun,
		lifecycleResumeKind,
		refreshDesktopProjectAttachments as refreshDesktopProjectAttachmentsFromDesktop,
		projectFromAttachment,
		resolveSubmissionId,
		verifyProjectAttachment as verifyProjectAttachmentForExecution,
		type ProjectState
	} from '$lib/home/desktop';
	import { formatElapsedDuration } from '$lib/format';
	import { convexClientErrorMessage } from '$lib/convex-error';
	import { validateImageAttachmentAddition, type ComposerAttachment } from '$lib/chat/attachments';
	import { defaultModelId, defaultReasoningEffort, defaultServiceTier } from '$convex/lib/models';
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
		getProjectThreadGroups,
		isActiveThread,
		isAgentLaunchPending,
		isLatestRunReadyForThread,
		pickThreadToRestore,
		resolveExpiredAgentLaunch,
		resolvePendingAgentLaunch,
		resolvePendingCreatedThreadId,
		resolveProjectThreadSelection,
		threadRecordToSummary,
		type PendingAgentLaunch,
		type PendingAgentLaunches
	} from '$lib/project/threads';
	import { mergePagedTranscriptWithLive, mergeTranscriptMessages } from '$lib/project/transcript';
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
		ThreadMessage,
		ThreadSummary,
		ProjectAttachment
	} from '$lib/types/sprocket';

	const convexAuth = useAuth();
	let sawAuthLoadingDuringRetry = $state(false);
	const isSignedIn = $derived(Boolean($authState.user));
	const signedInUserId = $derived($authState.user?.id ?? null);
	const retryPending = $derived($convexAuthRetryPending);
	const nativeAuthLoading = $derived($authState.nativeSession === 'loading');
	const nativeAuthBlocked = $derived(
		$authState.nativeSession === 'missing' ||
			$authState.nativeSession === 'mismatch' ||
			$authState.nativeSession === 'unavailable'
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
	const answerAgentQuestion = useMutation(api.agentQuestions.answer);
	const setThemePreference = useMutation(api.uiPreferences.setTheme);
	const generateImageUploadUrl = useMutation(api.imageUploads.generateUploadUrl);
	const registerImageUpload = useMutation(api.imageUploads.register);
	const discardImageUpload = useMutation(api.imageUploads.discard);
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
		imageUploadIds?: Id<'imageUploads'>[];
		reasoningEffort?: string;
		serviceTier?: string;
		selectedModel?: CatalogModelId;
		submissionId?: string;
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
	let selectedServiceTier = $state<string>(defaultServiceTier);
	let prompt = $state('');
	let selectedQuestionOptionId = $state<string | null>(null);
	let answeringAgentQuestion = $state(false);
	let composerAttachments = $state<ComposerAttachment[]>([]);
	let currentError = $state<string | null>(null);
	let elapsedSeconds = $state(0);
	const submittingPromptScopes = new SvelteMap<string, number>();
	const composerRecoveries = new SvelteMap<string, ComposerRecovery>();
	const recoveredSubmissionIds = new SvelteMap<
		string,
		{
			prompt: string;
			imageUploadIds: Id<'imageUploads'>[];
			reasoningEffort: string;
			serviceTier: string;
			selectedModel: CatalogModelId;
			submissionId: string;
		}
	>();
	const latestSubmissionSequencesByRecoveryScope = new SvelteMap<string, number>();
	let pendingAgentLaunches = $state<PendingAgentLaunches>({});
	let nextAgentLaunchId = 0;
	let nextSubmissionSequence = 0;
	let hasResolvedInitialSelection = $state(false);
	let restoredWorkspacePathToAttach = $state<string | null>(null);
	let lastSyncedComposerThreadId: Id<'threadRecords'> | null = null;
	let projectSelectionGeneration = $state(0);
	let pendingCreatedThreadId = $state<Id<'threadRecords'> | null>(null);
	let desktopProjectAttachmentsByPath = $state<Record<string, ProjectAttachment>>({});
	let hasLoadedDesktopProjectAttachments = $state(false);
	let desktopProjectAttachmentsGeneration = 0;
	let threadSnapshotReady = $state(false);
	let threadCacheStatus = $state<ThreadCacheStatus>('loading');
	let threadSnapshotThreads = $state<Doc<'threadRecords'>[]>([]);
	let threadCacheGeneration = 0;
	let threadSnapshotPullGeneration = 0;
	let selectionUserId = $state<string | null>(null);
	let projectPickerOpen = $state(false);
	let projectPickerMode = $state<'add' | 'reconnect'>('add');
	let projectPickerExpectedDisplayName = $state<string | undefined>(undefined);
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
		return $authState.user && convexAuth.isAuthenticated && !convexAuth.isLoading ? {} : 'skip';
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
	const artifactsQuery = useQuery(
		api.artifacts.listArtifactsForThread,
		authenticatedThreadQueryArgs
	);
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
	const projects = $derived.by<ProjectState[]>(() =>
		Object.values(desktopProjectAttachmentsByPath)
			.sort((left, right) => right.lastUsedAt - left.lastUsedAt)
			.map(projectFromAttachment)
	);
	const threads = $derived(threadSnapshotThreads.map(threadRecordToSummary));
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
	const currentLifecycle = $derived(dataForThread(lifecycleQuery.data, currentThreadId));
	const pendingAgentQuestion = $derived(
		dataForThread(pendingAgentQuestionQuery.data, currentThreadId)
	);
	let replicaMessages = $state<ThreadMessage[]>([]);
	let replicaNextBefore = $state<number | null>(null);
	let replicaStale = $state(false);
	let replicaThreadId = $state<Id<'threadRecords'> | null>(null);
	let replicaLoading = $state(false);
	let replicaError = $state<string | null>(null);
	let replicaGeneration = 0;
	let loadingOlderTranscriptGeneration = $state<number | null>(null);
	const loadingTranscriptDetails = new SvelteSet<string>();
	let liveCompletion = $state<LiveCompletionOverlay | null>(null);
	const loadingOlderTranscript = $derived(loadingOlderTranscriptGeneration === replicaGeneration);

	function applyOlderPageCursor(nextBefore: number | undefined) {
		replicaNextBefore = nextBefore ?? null;
	}

	function showReplicaForThread(threadId: Id<'threadRecords'> | null) {
		replicaGeneration += 1;
		loadingTranscriptDetails.clear();
		replicaThreadId = threadId;
		liveCompletion = null;
		replicaError = null;
		replicaMessages = [];
		replicaNextBefore = null;
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
		const generation = replicaGeneration;
		void (async () => {
			try {
				const page = await api.fetchTranscriptPage({
					userId,
					threadId: watchedThreadId,
					limit: 1
				});
				if (
					ac.signal.aborted ||
					currentThreadId !== watchedThreadId ||
					replicaGeneration !== generation
				) {
					return;
				}
				replicaMessages = page.messages;
				replicaStale = page.stale;
				replicaLoading = false;
				replicaError = null;
				applyOlderPageCursor(page.nextBefore);
			} catch {
				if (!ac.signal.aborted && replicaGeneration === generation) {
					replicaLoading = false;
					if (replicaMessages.length === 0) {
						replicaError = 'Could not load conversation history.';
					} else {
						replicaStale = true;
					}
				}
			}
			try {
				if (ac.signal.aborted || currentThreadId !== watchedThreadId) {
					return;
				}
				await api.watchTranscript(
					{ userId, threadId: watchedThreadId },
					{
						signal: ac.signal,
						onEvent: (event) => {
							if (ac.signal.aborted || currentThreadId !== watchedThreadId) {
								return;
							}
							replicaStale = event.stale;
							void refreshNewestTranscriptPage(watchedThreadId, userId);
						}
					}
				);
			} catch {
				if (!ac.signal.aborted) {
					replicaStale = true;
				}
			}
		})();
		return () => {
			ac.abort();
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

	const visibleMessages = $derived.by((): ThreadMessage[] => {
		const userId = getCurrentUserId();
		if (!currentThreadId || !userId || replicaThreadId !== currentThreadId) {
			return [];
		}
		if (replicaLoading && replicaMessages.length === 0) {
			return [];
		}
		const live = latestRunResumeKind ? null : liveCompletion;
		return mergePagedTranscriptWithLive({
			messages: replicaMessages,
			live,
			userId,
			threadId: currentThreadId
		});
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

	const runState = $derived(currentLifecycle?.run ?? null);
	const visibleActions: ExecutorJob[] = [];
	const threadArtifacts = $derived(
		(artifactsQuery.data ?? []).map((entry) => ({
			key: entry.artifact._id,
			title: entry.artifact.title,
			artifactType: entry.artifact.type,
			content: entry.currentContent
		}))
	);
	// Panel state snapshots survive thread switches; the live thread always has
	// an entry after the restore effect below runs.
	const sidePanelSnapshots = new SvelteMap<Id<'threadRecords'>, SidePanelSnapshot>();
	let sidePanel = $state<SidePanelSnapshot>({ ...DEFAULT_SIDE_PANEL_SNAPSHOT });
	let sidePanelThreadId: Id<'threadRecords'> | null = null;
	// Baseline for create/update detection; null means the next observation only seeds.
	let artifactRevisionWatch: {
		threadId: Id<'threadRecords'>;
		revisions: Map<string, ArtifactRevision>;
	} | null = null;
	// Baseline for browser-activity detection; same seeding rule as artifacts.
	let browserLiveViewWatch: {
		threadId: Id<'threadRecords'>;
		runId: Id<'runs'> | null;
	} | null = null;

	$effect(() => {
		const threadId = currentThreadId;
		if (threadId === sidePanelThreadId) return;
		if (sidePanelThreadId) {
			sidePanelSnapshots.set(sidePanelThreadId, sidePanel);
		}
		sidePanelThreadId = threadId;
		artifactFullscreenKey = null;
		sidePanel = {
			...((threadId && sidePanelSnapshots.get(threadId)) || DEFAULT_SIDE_PANEL_SNAPSHOT)
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
			id: entry.artifact._id,
			currentVersion: entry.artifact.currentVersion,
			updatedAt: entry.artifact.updatedAt
		}));
		const previous = artifactRevisionWatch?.revisions ?? null;
		const { revisions, changedId } = nextArtifactRevisionWatch(previous, current);
		artifactRevisionWatch = { threadId, revisions };

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
	const groupedProjectThreads = $derived(getProjectThreadGroups(projects, threads));
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
		if (event.status !== 'loading') {
			threadSnapshotReady = true;
		}
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
				threadSnapshotReady = true;
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

	function startThreadDraftForProject(workspacePath: string) {
		openProject(workspacePath, { draft: true });
	}

	function selectThread(thread: ThreadSummary, workspacePath: string) {
		openProject(workspacePath, { threadId: thread.threadId });
	}

	async function renameThread(threadId: Id<'threadRecords'>, title: string) {
		try {
			const { api, userId } = localThreadCommandContext();
			const cacheSynchronized = await api.renameThread({ userId, threadId, title });
			if (!cacheSynchronized) threadCacheStatus = 'reconnecting';
			await pullThreadSnapshot(userId);
		} catch (error) {
			currentError = error instanceof Error ? error.message : 'Failed to rename thread.';
		}
	}

	async function refreshNewestTranscriptPage(threadId: Id<'threadRecords'>, userId: string) {
		const api = desktopApi;
		if (!api || currentThreadId !== threadId) {
			return;
		}
		const generation = replicaGeneration;
		const page = await api.fetchTranscriptPage({ userId, threadId, limit: 1 });
		if (currentThreadId !== threadId || replicaGeneration !== generation) {
			return;
		}
		const hadMessages = replicaMessages.length > 0;
		replicaMessages = mergeTranscriptMessages(replicaMessages, page.messages);
		replicaStale = page.stale;
		if (!hadMessages) {
			applyOlderPageCursor(page.nextBefore);
		} else if (replicaNextBefore != null && page.nextBefore != null) {
			replicaNextBefore = Math.min(replicaNextBefore, page.nextBefore);
		}
	}

	async function loadOlderTranscript() {
		const api = desktopApi;
		const threadId = currentThreadId;
		const userId = getCurrentUserId();
		const before = replicaNextBefore;
		const generation = replicaGeneration;
		if (
			!api ||
			!threadId ||
			!userId ||
			before == null ||
			loadingOlderTranscriptGeneration === generation
		) {
			return;
		}
		loadingOlderTranscriptGeneration = generation;
		try {
			if (currentThreadId !== threadId || replicaGeneration !== generation) {
				return;
			}
			const page = await api.fetchTranscriptPage({
				userId,
				threadId,
				before,
				limit: 1
			});
			if (currentThreadId !== threadId || replicaGeneration !== generation) {
				return;
			}
			replicaMessages = mergeTranscriptMessages(replicaMessages, page.messages);
			replicaStale = page.stale;
			applyOlderPageCursor(page.nextBefore);
		} catch {
			if (currentThreadId === threadId && replicaGeneration === generation) {
				replicaStale = true;
			}
		} finally {
			if (loadingOlderTranscriptGeneration === generation) {
				loadingOlderTranscriptGeneration = null;
			}
		}
	}

	async function loadTranscriptAttachment(imageUploadId: Id<'imageUploads'>) {
		const api = desktopApi;
		const threadId = currentThreadId;
		const userId = getCurrentUserId();
		if (!api || !threadId || !userId) {
			return null;
		}
		const blob = await api.fetchTranscriptAttachment({
			userId,
			threadId,
			imageUploadId
		});
		return blob ? URL.createObjectURL(blob) : null;
	}

	async function loadTranscriptMessageDetails(message: ThreadMessage) {
		const api = desktopApi;
		const threadId = currentThreadId;
		const userId = getCurrentUserId();
		if (
			!api ||
			!threadId ||
			!userId ||
			message.detailsLoaded ||
			!message.sourceNumbers?.length ||
			loadingTranscriptDetails.has(message._id)
		) {
			return;
		}
		loadingTranscriptDetails.add(message._id);
		try {
			const details = await api.fetchTranscriptDetails({
				userId,
				threadId,
				numbers: message.sourceNumbers
			});
			if (currentThreadId !== threadId) return;
			replicaMessages = replicaMessages.map((entry) =>
				entry._id === details._id ? details : entry
			);
		} catch {
			if (currentThreadId === threadId) replicaStale = true;
		} finally {
			loadingTranscriptDetails.delete(message._id);
		}
	}

	async function archiveThread(threadId: Id<'threadRecords'>) {
		const archiveUserId = getCurrentUserId();
		try {
			const { api, userId } = localThreadCommandContext();
			const cacheSynchronized = await api.archiveThread({ userId, threadId });
			if (!cacheSynchronized) threadCacheStatus = 'reconnecting';
			await pullThreadSnapshot(userId);
			if (archiveUserId) {
				clearComposerRecovery(archiveUserId, `thread:${threadId}`);
				const api = desktopApi;
				if (api) {
					await api.clearTranscriptReplica({
						userId: archiveUserId,
						threadId
					});
				}
			}
			if (getCurrentUserId() === archiveUserId) {
				if (currentThreadId === threadId) {
					currentThreadId = null;
					projectSelectionGeneration += 1;
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
			const { api, userId } = localThreadCommandContext();
			const cacheSynchronized = await api.restoreThread({ userId, threadId });
			if (!cacheSynchronized) threadCacheStatus = 'reconnecting';
			await pullThreadSnapshot(userId);
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
			const answer = {
				threadId,
				questionId: question.questionId,
				optionId: submittedOptionId ?? undefined,
				text: answerText || undefined
			};
			await answerAgentQuestion(answer);
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

		elapsedSeconds = 0;

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
		const submittedImageUploadIds = submittedAttachments.flatMap((attachment) =>
			attachment.imageUploadId ? [attachment.imageUploadId] : []
		);
		const submittedModel = selectedModel;
		const submittedReasoningEffort = selectedReasoningEffort;
		const submittedServiceTier = selectedServiceTier;
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
							status: isLifecycleInProgress(currentLifecycle.phase) ? 'queued' : 'completed',
							submissionId: currentRecoveredSubmission?.submissionId ?? ''
						},
			newSubmissionId: freshSubmissionId,
			prompt: submittedPrompt,
			imageUploadIds: submittedImageUploadIds,
			reasoningEffort: submittedReasoningEffort,
			serviceTier: submittedServiceTier,
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
						void pullThreadSnapshot(submittedUserId);
						if (repositoryKeyChanged)
							remoteChangeNotices.set(createdThreadId, REMOTE_CHANGE_NOTICE);
					}
					clearComposerAttachments({ discard: false });
				},
				threadId: threadId ?? undefined,
				repositoryKey: threadId ? undefined : submittedRepositoryKey,
				prompt: submittedPrompt,
				imageUploadIds: submittedImageUploadIds,
				selectedModel: submittedModel,
				submissionId: runSubmissionId,
				reasoningEffort: submittedReasoningEffort,
				serviceTier: submittedServiceTier,
				workspacePath
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
				imageUploadIds: [],
				selectedModel,
				reasoningEffort: selectedReasoningEffort,
				serviceTier: selectedServiceTier,
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
		restoredWorkspacePathToAttach = null;
		ensureSubscriptionAttemptedFor = null;
		lastSyncedComposerThreadId = null;
		threadSnapshotReady = false;
		threadCacheStatus = 'loading';
		threadSnapshotThreads = [];
		threadSnapshotPullGeneration += 1;
		projectSelectionGeneration += 1;
		prompt = '';
		clearComposerAttachments({ discard: true });
		currentError = null;
		elapsedSeconds = 0;
		selectedModel = modelCatalog?.defaultModelId ?? defaultModelId;
		selectedReasoningEffort = modelCatalog?.defaultReasoningEffort ?? defaultReasoningEffort;
		selectedServiceTier = modelCatalog?.defaultServiceTier ?? defaultServiceTier;
		projectPickerOpen = false;
		projectPickerReconnectWorkspacePath = null;
		projectPickerExpectedDisplayName = undefined;
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
		restoredWorkspacePathToAttach = null;
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
		if (!thread) return;
		selectedModel = thread.selectedModel;
		selectedReasoningEffort = thread.reasoningEffort;
		selectedServiceTier = thread.serviceTier;
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
		if (
			hasResolvedInitialSelection ||
			!initialProjectLaunchResolved ||
			pendingProjectLaunches.length > 0 ||
			projectLaunchInFlight
		) {
			return;
		}

		if (!hasLoadedDesktopProjectAttachments || !threadSnapshotReady) {
			return;
		}

		hasResolvedInitialSelection = true;
		const localRepositoryKeys = new Set(projects.map((project) => project.repositoryKey));
		const restoredThread = pickThreadToRestore(
			threads.filter((thread) => localRepositoryKeys.has(thread.repositoryKey))
		);
		if (restoredThread) {
			const restoredProject = findProjectByRepositoryKey(projects, restoredThread.repositoryKey);
			if (restoredProject) {
				setProjectSelection(restoredProject.workspacePath, restoredThread.threadId, false, true);
				restoredWorkspacePathToAttach = restoredProject.workspacePath;
				return;
			}
		}

		if (projects[0]) {
			setProjectSelection(projects[0].workspacePath, null, false, true);
			restoredWorkspacePathToAttach = projects[0].workspacePath;
		}
	});

	$effect(() => {
		const workspacePath = restoredWorkspacePathToAttach;
		if (!workspacePath || !desktopApi || !hasLoadedDesktopProjectAttachments) {
			return;
		}

		const project = findProjectByWorkspacePath(projects, workspacePath);
		if (!project) {
			restoredWorkspacePathToAttach = null;
			return;
		}

		restoredWorkspacePathToAttach = null;
		const selectionGeneration = projectSelectionGeneration;
		void verifyProject(workspacePath).catch((error) => {
			if (selectionGeneration === projectSelectionGeneration) {
				currentError = error instanceof Error ? error.message : 'Failed to attach project.';
			}
		});
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

	onMount(() => {
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
			onRetry={() => void (nativeAuthBlocked ? signIn() : retryConvexAuthentication())}
			retryLabel={nativeAuthBlocked ? 'Finish sign-in' : 'Retry'}
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
			sidePanel.open &&
			!sidePanel.expanded
				? 'pr-[20rem]'
				: ''}"
			inert={fullscreenArtifact || (sidePanel.open && sidePanel.expanded) ? true : undefined}
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
					{currentWorkspacePath}
					{currentThreadId}
					groups={groupedProjectThreads}
					{pendingAgentLaunches}
					theme={workspaceTheme}
					onThemeChange={(theme) => void handleThemeChange(theme)}
					onAddProject={() => {
						openProjectPicker('add');
					}}
					onReconnectProject={(workspacePath) => {
						void reconnectProject(workspacePath);
					}}
					onOpenSettings={() => {
						settingsPage = 'account';
						settingsOpen = true;
					}}
					onStartThreadDraft={startThreadDraftForProject}
					onSelectThread={selectThread}
					onSelectProject={(workspacePath) => {
						openProject(workspacePath);
					}}
					onRenameThread={(threadId, title) => {
						void renameThread(threadId, title);
					}}
					onArchiveThread={(threadId) => {
						void archiveThread(threadId);
					}}
				/>
			{/if}

			<main class="relative flex h-screen min-h-0 min-w-0 flex-col overflow-hidden">
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
					{#key currentThreadId}
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
							activeRunId={isRunning ? (runState?.runId ?? null) : null}
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
							hasOlder={replicaNextBefore != null}
							emptyStateMessage={currentThreadId &&
							(replicaLoading || replicaThreadId !== currentThreadId)
								? 'Loading conversation…'
								: currentProject
									? 'Start a thread and ask Sprocket to inspect code, edit files, or run project commands.'
									: 'Add a project to begin.'}
							onLoadOlder={() => {
								void loadOlderTranscript();
							}}
							loadAttachment={loadTranscriptAttachment}
							onLoadDetails={(message) => loadTranscriptMessageDetails(message)}
						/>
					{/key}

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
						bind:selectedServiceTier
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
					liveView={browserLiveViewQuery.data}
					liveActive={isRunning && browserLiveViewQuery.data?.lastUsedRunId === runState?.runId}
					expanded={sidePanel.expanded}
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
