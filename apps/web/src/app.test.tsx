// @vitest-environment-options {"url":"https://sprocket.test/"}
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import type { AgentQuestionSnapshot } from '@convex/agentQuestions';
import { defaultModelId, defaultReasoningEffort } from '@convex/lib/models';
import { authState, resetAuthRuntime } from '$lib/auth';
import type { ModelCatalog } from '$lib/chat/model-catalog';
import { ConvexTestClient, ConvexTestProvider } from '$lib/convex-test-client';
import type { RuntimeConfig } from '$lib/runtime-config';
import type { UpdateState } from '$lib/updates';
import type { DesktopApi, ProjectAttachment, TranscriptDisplayPage } from '$lib/types/sprocket';
import App, { type AppRuntime } from './app';

const modelCatalog: ModelCatalog = {
	defaultModelId,
	defaultReasoningEffort,
	models: [
		{
			id: defaultModelId,
			label: 'Model One',
			provider: 'spikonado',
			supportsImages: false,
			contextWindowTokens: 100_000,
			autoHandoffTokenLimit: 80_000,
			reasoningEfforts: ['low', 'medium'],
			defaultReasoningEffort,
			supportsFastMode: true
		}
	],
	tierAllowedModels: { pro: [defaultModelId], free: [defaultModelId] },
	tierAllowsFastMode: { pro: true, free: false },
	modelLockUpgradeMessage: 'Upgrade to unlock this model',
	fastModeLockUpgradeMessage: 'Upgrade to use Fast mode'
};

const testConfig: RuntimeConfig = {
	machine: false,
	env: { PUBLIC_MODEL_GATEWAY_URL: 'https://gateway.test' }
};

function projectAttachment(
	workspacePath: string,
	repositoryKey: string,
	displayName = repositoryKey,
	availability: ProjectAttachment['availability'] = 'available',
	unavailableReason?: string
): ProjectAttachment {
	return {
		workspacePath,
		repositoryKey,
		attachmentKey: `remote:${repositoryKey}`,
		displayName,
		availability,
		lastValidatedAt: 1,
		lastUsedAt: 1,
		unavailableReason
	};
}

function threadRecord(id: string, repositoryKey: string, title: string): Doc<'threadRecords'> {
	return {
		// SAFETY: fixture strings are only compared as opaque Convex document ids.
		_id: id as Id<'threadRecords'>,
		_creationTime: 1,
		userId: 'user-a',
		submissionId: 'submission-1',
		status: 'completed',
		repositoryKey,
		title,
		selectedModel: defaultModelId,
		reasoningEffort: defaultReasoningEffort,
		fastMode: false,
		lastMessageAt: 1
	};
}

function emptyDisplayPage(replicaId: string): TranscriptDisplayPage {
	return {
		replicaId,
		rows: [],
		indexing: false,
		stale: false,
		endSequence: 0,
		revision: 0,
		persistedStreams: [],
		changes: [],
		changesCursor: { revision: 0, sequence: -1 },
		moreChanges: false
	};
}

function createDesktopApi(overrides: Partial<DesktopApi> = {}): DesktopApi {
	const unused = () => Promise.reject(new Error('unexpected desktop API call'));
	return {
		browseFilesystem: unused,
		listWorkspaceSkills: async () => ({ skills: [], warnings: [] }),
		resolveWorkspacePath: unused,
		listProjectAttachments: async () => [],
		attachProject: unused,
		runAgent: unused,
		fetchTranscriptDisplay: async () => emptyDisplayPage('replica-1'),
		fetchTranscriptDisplayDetails: unused,
		watchTranscript: () => new Promise<void>(() => {}),
		watchLiveCompletion: () => new Promise<void>(() => {}),
		clearTranscriptReplica: async () => {},
		fetchTranscriptAttachment: unused,
		uploadTranscriptAttachment: unused,
		discardTranscriptAttachment: unused,
		watchArtifacts: () => new Promise<void>(() => {}),
		requestRunCancellation: async () => {},
		startAccountSession: async () => {},
		endAccountSession: async () => {},
		fetchChatGptStatus: async () => ({
			accounts: [],
			activeConnectionId: null,
			models: [],
			loginAvailable: false
		}),
		startChatGptBrowserLogin: unused,
		fetchChatGptBrowserLoginResult: unused,
		cancelChatGptBrowserLogin: async () => {},
		selectChatGptAccount: unused,
		disconnectChatGptAccount: unused,
		...overrides
	};
}

function createConvexFixtures(): ConvexTestClient {
	const client = new ConvexTestClient();
	client.registerQuery(api.uiPreferences.getMine, null);
	client.registerQuery(api.usage.getMyUsage, {
		tier: 'free',
		tierLabel: 'Free',
		exhausted: false,
		resetsAt: null,
		meters: []
	});
	client.registerQuery(api.artifacts.listArtifacts, {
		page: [],
		isDone: true,
		continueCursor: '',
		revision: 0
	});
	client.registerQuery(api.artifacts.getArtifactState, 0);
	client.registerAction(api.providerCredentials.getMyConfiguration, {
		openai: false,
		chatgpt: false,
		chatgptModelIds: null
	});
	client.registerMutation(api.billing.ensureMySubscription, null);
	return client;
}

function createRuntime(desktopApi: DesktopApi): AppRuntime {
	return {
		resolveDesktopApi: async () => desktopApi,
		fetchGatewayModelCatalog: async () => modelCatalog
	};
}

async function renderApp(client: ConvexTestClient, runtime: AppRuntime): Promise<void> {
	await act(async () => {
		render(
			<ConvexTestProvider client={client}>
				<App config={testConfig} runtime={runtime} />
			</ConvexTestProvider>
		);
		// Let the boot promise chain settle inside act so every state update is covered.
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

async function flushPendingWork(): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function projectTrigger(name: string) {
	return screen.findByRole('button', { name: `Select project. Current project: ${name}` });
}

async function openProjectFromHeading(from: string, target: string) {
	fireEvent.click(await projectTrigger(from));
	fireEvent.click(screen.getByRole('menuitemradio', { name: target }));
	await flushPendingWork();
}

beforeEach(() => {
	vi.stubGlobal(
		'fetch',
		vi.fn<typeof fetch>(async (input, options) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url !== 'https://sprocket.test/api/update' || options?.method !== 'GET') {
				throw new Error(`Unexpected network request: ${url}`);
			}
			return Response.json({
				method: 'package',
				status: 'unavailable',
				currentVersion: 'test',
				version: null,
				error: null
			} satisfies UpdateState);
		})
	);
	vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
	authState.set({
		isLoading: false,
		isReady: true,
		isConfigured: true,
		isWaitingForBrowserSignIn: false,
		browserSignInUrl: null,
		user: {
			id: 'user-a',
			email: 'a@example.com',
			firstName: null,
			lastName: null,
			profilePictureUrl: null
		},
		nativeSession: 'ready',
		error: null
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	cleanup();
	resetAuthRuntime();
});

it('populates projects from the desktop client resolved during boot', async () => {
	const listProjectAttachments = vi.fn(async () => [
		projectAttachment('/work/alpha', 'repo-alpha', 'Alpha')
	]);

	await renderApp(
		createConvexFixtures(),
		createRuntime(createDesktopApi({ listProjectAttachments }))
	);

	expect(await projectTrigger('Alpha')).toBeTruthy();
	expect(listProjectAttachments).toHaveBeenCalled();
});

it('surfaces a verification failure for the initially selected project', async () => {
	const unavailable = projectAttachment(
		'/work/alpha',
		'repo-alpha',
		'Alpha',
		'unavailable',
		'Alpha is offline.'
	);

	await renderApp(
		createConvexFixtures(),
		createRuntime(createDesktopApi({ listProjectAttachments: async () => [unavailable] }))
	);

	expect(await projectTrigger('Alpha')).toBeTruthy();
	expect(await screen.findByText('Alpha is offline.')).toBeTruthy();
});

it('keeps the project the user opens while an earlier attachment refresh is in flight', async () => {
	const alpha = projectAttachment('/work/alpha', 'repo-alpha', 'Alpha');
	const beta = projectAttachment('/work/beta', 'repo-beta', 'Beta');
	const gamma = projectAttachment('/work/gamma', 'repo-gamma', 'Gamma');
	const canonicalAlpha = projectAttachment('/work/alpha-renamed', 'repo-alpha', 'Alpha (renamed)');
	const verifyBeta = Promise.withResolvers<ProjectAttachment[]>();
	const staleRefresh = Promise.withResolvers<ProjectAttachment[]>();
	const resolveWorkspacePath = vi.fn(async () => ({
		workspacePath: alpha.workspacePath,
		displayName: alpha.displayName,
		repositoryKey: alpha.repositoryKey
	}));
	let listCalls = 0;
	const listProjectAttachments = async () => {
		listCalls += 1;
		if (listCalls <= 3) return [alpha, beta, gamma];
		if (listCalls === 4) return verifyBeta.promise;
		if (listCalls === 5) return staleRefresh.promise;
		return new Promise<ProjectAttachment[]>(() => {});
	};

	await renderApp(
		createConvexFixtures(),
		createRuntime(createDesktopApi({ listProjectAttachments, resolveWorkspacePath }))
	);
	await projectTrigger('Alpha');
	await waitFor(() => expect(listCalls).toBe(3));

	// Opening Beta starts a verification whose refresh stays in flight.
	await openProjectFromHeading('Alpha', 'Beta');
	await projectTrigger('Beta');
	await waitFor(() => expect(listCalls).toBe(4));
	await act(async () => {
		verifyBeta.resolve([alpha, beta, gamma]);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	await waitFor(() => expect(listCalls).toBe(5));

	// Move on to Gamma while Beta's refresh is still loading, then let that
	// refresh finish with a list that no longer has Beta.
	await openProjectFromHeading('Beta', 'Gamma');
	await projectTrigger('Gamma');
	await waitFor(() => expect(listCalls).toBe(6));
	await act(async () => {
		staleRefresh.resolve([gamma, canonicalAlpha]);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

	expect(await projectTrigger('Gamma')).toBeTruthy();
	expect(resolveWorkspacePath).not.toHaveBeenCalled();
});

it('keeps a saved theme until the preference subscription advances', async () => {
	const client = createConvexFixtures();
	const save = Promise.withResolvers<null>();
	const preferences: Doc<'uiPreferences'> = {
		// SAFETY: fixture strings are only compared as opaque Convex document ids.
		_id: 'preferences-a' as Id<'uiPreferences'>,
		_creationTime: 1,
		userId: 'user-a',
		theme: 'light'
	};
	client.registerQuery(api.uiPreferences.getMine, preferences);
	client.registerMutation(api.uiPreferences.setTheme, save.promise);
	await renderApp(client, createRuntime(createDesktopApi()));
	fireEvent.click(await screen.findByRole('button', { name: 'Switch to dark mode' }));
	await act(async () => {
		save.resolve(null);
	});
	expect(document.documentElement.dataset.theme).toBe('dark');
	expect(screen.getByRole('button', { name: 'Switch to light mode' })).toBeTruthy();
	await act(async () => {
		client.registerQuery(api.uiPreferences.getMine, { ...preferences, theme: 'dark' });
	});
	expect(document.documentElement.dataset.theme).toBe('dark');
	await act(async () => {
		client.registerQuery(api.uiPreferences.getMine, { ...preferences, theme: 'light' });
	});
	expect(document.documentElement.dataset.theme).toBe('light');
	expect(screen.getByRole('button', { name: 'Switch to dark mode' })).toBeTruthy();
});

it('applies a remote theme update received while a local theme save is pending', async () => {
	const client = createConvexFixtures();
	const save = Promise.withResolvers<null>();
	const preferences: Doc<'uiPreferences'> = {
		// SAFETY: fixture strings are only compared as opaque Convex document ids.
		_id: 'preferences-a' as Id<'uiPreferences'>,
		_creationTime: 1,
		userId: 'user-a',
		theme: 'light'
	};
	client.registerQuery(api.uiPreferences.getMine, preferences);
	client.registerMutation(api.uiPreferences.setTheme, save.promise);
	await renderApp(client, createRuntime(createDesktopApi()));
	fireEvent.click(await screen.findByRole('button', { name: 'Switch to dark mode' }));
	expect(document.documentElement.dataset.theme).toBe('dark');
	await act(async () => {
		client.registerQuery(api.uiPreferences.getMine, { ...preferences, theme: 'dark' });
	});
	await act(async () => {
		client.registerQuery(api.uiPreferences.getMine, { ...preferences, theme: 'light' });
	});
	expect(document.documentElement.dataset.theme).toBe('dark');
	await act(async () => {
		save.resolve(null);
	});
	expect(document.documentElement.dataset.theme).toBe('light');
	expect(screen.getByRole('button', { name: 'Switch to dark mode' })).toBeTruthy();
});

it('submits with current attachments when a newer refresh supersedes the submission refresh', async () => {
	const alpha = projectAttachment('/work/alpha', 'repo-alpha', 'Alpha');
	const beta = projectAttachment('/work/beta', 'repo-beta', 'Beta');
	const changedAlpha = projectAttachment('/work/alpha', 'repo-new-alpha', 'Alpha');
	const staleRefresh = Promise.withResolvers<ProjectAttachment[]>();
	const runAgent = vi.fn(async () => ({
		// SAFETY: fixture strings are only compared as opaque Convex document ids.
		runId: 'run-new' as Id<'runs'>,
		// SAFETY: fixture strings are only compared as opaque Convex document ids.
		threadId: 'thread-new' as Id<'threadRecords'>
	}));
	let listCalls = 0;
	const listProjectAttachments = async () => {
		listCalls += 1;
		if (listCalls <= 3) return [alpha, beta];
		if (listCalls === 4) return staleRefresh.promise;
		return [changedAlpha, beta];
	};
	await renderApp(
		createConvexFixtures(),
		createRuntime(
			createDesktopApi({
				listProjectAttachments,
				resolveWorkspacePath: async () => ({
					workspacePath: changedAlpha.workspacePath,
					repositoryKey: changedAlpha.repositoryKey,
					displayName: changedAlpha.displayName
				}),
				runAgent
			})
		)
	);
	await projectTrigger('Alpha');
	await waitFor(() => expect(listCalls).toBe(3));
	fireEvent.change(
		screen.getByPlaceholderText(
			'Ask anything, @tag files/directories, or use $ to show available skills'
		),
		{ target: { value: 'Fix the robot' } }
	);
	fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
	await waitFor(() => expect(listCalls).toBe(4));
	await openProjectFromHeading('Alpha', 'Beta');
	await waitFor(() => expect(listCalls).toBe(6));
	await act(async () => {
		staleRefresh.resolve([]);
	});
	await waitFor(() =>
		expect(runAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				workspacePath: '/work/alpha',
				repositoryKey: 'repo-new-alpha',
				prompt: 'Fix the robot'
			})
		)
	);
});

it('restores the submitted prompt and error when an agent launch fails', async () => {
	const alpha = projectAttachment('/work/alpha', 'repo-alpha', 'Alpha');
	const listProjectAttachments = vi.fn(async () => [alpha]);
	const launch = Promise.withResolvers<Awaited<ReturnType<DesktopApi['runAgent']>>>();
	const runAgent = vi.fn<DesktopApi['runAgent']>(() => launch.promise);
	await renderApp(
		createConvexFixtures(),
		createRuntime(
			createDesktopApi({
				listProjectAttachments,
				resolveWorkspacePath: async () => alpha,
				runAgent
			})
		)
	);
	await projectTrigger('Alpha');
	await waitFor(() => expect(listProjectAttachments).toHaveBeenCalledTimes(3));
	const composer = screen.getByRole('combobox');
	fireEvent.change(composer, { target: { value: 'Fix the robot' } });
	const send = screen.getByRole('button', { name: 'Send message' });
	await waitFor(() => expect(send).toHaveProperty('disabled', false));
	fireEvent.click(send);
	await waitFor(() => expect(runAgent).toHaveBeenCalledOnce());
	expect(composer).toHaveProperty('value', '');
	await act(async () => {
		launch.reject(new Error('Local agent unavailable.'));
	});
	await waitFor(() => expect(composer).toHaveProperty('value', 'Fix the robot'));
	expect(screen.getByRole('alert')).toHaveProperty('textContent', 'Local agent unavailable.');
});

it('launches the continuation prompt after an agent question is answered', async () => {
	const alpha = projectAttachment('/work/alpha', 'repo-alpha', 'Alpha');
	const thread = threadRecord('thread-1', 'repo-alpha', 'Fix the robot');
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	const questionId = 'question-1' as Id<'agentQuestions'>;
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	const continuationRunId = 'run-1' as Id<'runs'>;
	const question: AgentQuestionSnapshot = {
		threadId: thread._id,
		questionId,
		question: 'Which board should I target?',
		options: [{ id: 'option-a', label: 'Option A' }],
		status: 'pending',
		sequence: 1,
		createdAt: 1,
		timeoutAt: 1_000_000
	};
	const runAgent = vi.fn(async () => ({
		// SAFETY: fixture strings are only compared as opaque Convex document ids.
		runId: 'run-2' as Id<'runs'>,
		threadId: thread._id
	}));
	const client = createConvexFixtures();
	client.registerPaginatedQuery(api.inbox.list, [thread]);
	client.registerQuery(api.threads.getByThreadId, {
		...thread,
		contextTokens: undefined,
		totalTokensProcessed: 0
	});
	client.registerQuery(api.chat.selectedThreadLifecycle, {
		threadId: thread._id,
		phase: 'waiting_for_input',
		run: { runId: continuationRunId, startedAt: 1 }
	});
	client.registerQuery(api.agentQuestions.headPendingForThread, question);
	client.registerMutation(api.agentQuestions.answer, {
		question: { ...question, status: 'answered', answer: { optionId: 'option-a' } },
		continuation: { runId: continuationRunId, prompt: 'Continue with the robot fix' }
	});

	await renderApp(
		client,
		createRuntime(createDesktopApi({ listProjectAttachments: async () => [alpha], runAgent }))
	);
	await projectTrigger('Alpha');
	fireEvent.click(await screen.findByText('Fix the robot'));
	expect(await screen.findByText('Which board should I target?')).toBeTruthy();

	fireEvent.change(screen.getByPlaceholderText('Add detail, or type a custom answer'), {
		target: { value: 'Use board A' }
	});
	fireEvent.click(screen.getByRole('button', { name: 'Option A' }));
	await act(async () => {
		fireEvent.click(screen.getByRole('button', { name: 'Submit answer' }));
	});

	await waitFor(() =>
		expect(runAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: 'Continue with the robot fix',
				continuationOfRunId: continuationRunId
			})
		)
	);
});
