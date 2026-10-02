// @vitest-environment-options {"url":"https://sprocket.test/"}
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FunctionReturnType } from 'convex/server';
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
	]
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
		listRunningCommands: vi.fn(async () => ({ commands: [] })),
		terminateCommand: vi.fn(async () => ({ terminated: true })),
		browseFilesystem: unused,
		listWorkspaceSkills: async () => ({ skills: [], warnings: [] }),
		searchWorkspace: unused,
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
		deleteArtifact: async () => {},
		watchArtifacts: () => new Promise<void>(() => {}),
		requestRunCancellation: async () => {},
		startAccountSession: async () => {},
		endAccountSession: async () => {},
		fetchChatGptStatus: async () => ({
			accounts: [],
			activeConnectionId: null,
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

async function renderThreadLaunch() {
	const alpha = projectAttachment('/work/alpha', 'repo-alpha', 'Alpha');
	const thread = threadRecord('thread-1', 'repo-alpha', 'Robot work');
	const otherThread = threadRecord('thread-2', 'repo-alpha', 'Other work');
	const launch = Promise.withResolvers<Awaited<ReturnType<DesktopApi['runAgent']>>>();
	const runAgent = vi.fn<DesktopApi['runAgent']>(() => launch.promise);
	const client = createConvexFixtures();
	client.registerPaginatedQuery(api.inbox.list, [thread, otherThread]);
	client.registerQuery(api.threads.getByThreadId, {
		...thread,
		contextTokens: undefined,
		totalTokensProcessed: 0
	});
	client.registerQuery(api.chat.selectedThreadLifecycle, {
		threadId: thread._id,
		phase: 'idle',
		run: null
	});
	await renderApp(
		client,
		createRuntime(createDesktopApi({ listProjectAttachments: async () => [alpha], runAgent }))
	);
	fireEvent.click(await screen.findByText('Robot work'));

	return { client, thread, launch, runAgent };
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
	vi.useRealTimers();
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

it('deletes an attached project artifact through the local server and keeps failures retryable', async () => {
	const client = createConvexFixtures();

	const artifact: FunctionReturnType<typeof api.artifacts.listArtifacts>['page'][number] = {
		// SAFETY: this fixture ID is only compared as an opaque Convex document ID.
		_id: 'artifact-a' as Id<'artifacts'>,
		_creationTime: 1,
		userId: 'user-a',
		repositoryKey: 'repo-alpha',
		scope: 'project',
		registrationId: 'registration-a',
		content: 'Notes',
		type: 'markdown',
		title: 'Artifact notes',
		revision: 1,
		createdAt: 1,
		updatedAt: 1
	};

	client.registerQuery(api.artifacts.listArtifacts, {
		page: [artifact],
		isDone: true,
		continueCursor: '',
		revision: 1
	});

	const deleteArtifact = vi
		.fn<DesktopApi['deleteArtifact']>()
		.mockRejectedValueOnce(new Error('artifact deletion timed out'))
		.mockResolvedValue(undefined);

	await renderApp(
		client,
		createRuntime(
			createDesktopApi({
				listProjectAttachments: async () => [
					projectAttachment('/work/alpha', 'repo-alpha', 'Alpha')
				],
				deleteArtifact
			})
		)
	);
	await projectTrigger('Alpha');
	fireEvent.click(await screen.findByRole('button', { name: 'Open side panel' }));
	fireEvent.contextMenu(await screen.findByText('Artifact notes'));
	fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete artifact' }));
	expect((await screen.findByRole('alert')).textContent).toContain('artifact deletion timed out');
	fireEvent.click(screen.getByRole('menuitem', { name: 'Delete artifact' }));
	await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
	expect(deleteArtifact).toHaveBeenCalledTimes(2);
	expect(deleteArtifact).toHaveBeenLastCalledWith({
		userId: 'user-a',
		repositoryKey: 'repo-alpha',
		workspacePath: '/work/alpha',
		artifactId: 'artifact-a'
	});
});

it('shares local message recency across the project menus and recent directories', async () => {
	const alpha = { ...projectAttachment('/work/alpha', 'repo-alpha', 'Alpha'), lastUsedAt: 500 };

	const beta = {
		...projectAttachment('/work/beta', 'repo-beta', 'Beta'),
		lastMessageSentAt: 200
	};

	const gamma = {
		...projectAttachment('/work/gamma', 'repo-gamma', 'Gamma'),
		lastMessageSentAt: 100
	};

	await renderApp(
		createConvexFixtures(),
		createRuntime(
			createDesktopApi({
				listProjectAttachments: async () => [alpha, gamma, beta],
				browseFilesystem: async () => ({ parentPath: '/home', entries: [] })
			})
		)
	);
	fireEvent.click(await projectTrigger('Beta'));
	expect(
		screen.getAllByRole('menuitemradio').map((item) => item.getAttribute('aria-label'))
	).toEqual(['Beta', 'Gamma', 'Alpha']);
	fireEvent.click(await projectTrigger('Beta'));
	expect(
		Array.from(document.querySelectorAll('.inbox-project-option')).map((item) => item.textContent)
	).toEqual(['All projects', 'Beta', 'Gamma', 'Alpha']);
	fireEvent.click(screen.getByRole('button', { name: 'Create or add project' }));
	const dialog = await screen.findByRole('dialog');

	const recents = within(dialog)
		.getAllByRole('button')
		.filter((button) => ['alpha', 'beta', 'gamma'].includes(button.textContent ?? ''));

	expect(recents.map((button) => button.textContent)).toEqual(['beta', 'gamma', 'alpha']);
});

it('refreshes message recency after a successful send even when another project is open', async () => {
	const alpha = {
		...projectAttachment('/work/alpha', 'repo-alpha', 'Alpha'),
		lastMessageSentAt: 10
	};

	const beta = projectAttachment('/work/beta', 'repo-beta', 'Beta');
	const launch = Promise.withResolvers<Awaited<ReturnType<DesktopApi['runAgent']>>>();
	const runAgent = vi.fn<DesktopApi['runAgent']>(() => launch.promise);
	let sent = false;
	await renderApp(
		createConvexFixtures(),
		createRuntime(
			createDesktopApi({
				listProjectAttachments: async () => [alpha, { ...beta, lastMessageSentAt: sent ? 20 : 0 }],
				resolveWorkspacePath: async ({ workspacePath }) =>
					workspacePath === beta.workspacePath ? beta : alpha,
				runAgent
			})
		)
	);
	await openProjectFromHeading('Alpha', 'Beta');
	const composer = screen.getByRole('combobox');
	fireEvent.change(composer, { target: { value: 'Fix the robot' } });
	const send = screen.getByRole('button', { name: 'Send message' });
	await waitFor(() => expect(send).toHaveProperty('disabled', false));
	fireEvent.click(send);
	await waitFor(() => expect(runAgent).toHaveBeenCalledOnce());
	fireEvent.click(await projectTrigger('Beta'));
	expect(
		screen.getAllByRole('menuitemradio').map((item) => item.getAttribute('aria-label'))
	).toEqual(['Alpha', 'Beta']);
	fireEvent.click(await projectTrigger('Beta'));
	await openProjectFromHeading('Beta', 'Alpha');
	await act(async () => {
		sent = true;
		launch.resolve({
			// SAFETY: fixture strings are only compared as opaque Convex document ids.
			runId: 'run-new' as Id<'runs'>,
			// SAFETY: fixture strings are only compared as opaque Convex document ids.
			threadId: 'thread-new' as Id<'threadRecords'>
		});
	});
	fireEvent.click(await projectTrigger('Alpha'));
	await waitFor(() =>
		expect(
			screen.getAllByRole('menuitemradio').map((item) => item.getAttribute('aria-label'))
		).toEqual(['Beta', 'Alpha'])
	);
}, 15_000);

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
			'Ask anything, use / for commands, @ to tag files/folders, and $ for skills'
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

it('keeps a local submission Starting beyond the old timeout until it starts', async () => {
	const alpha = projectAttachment('/work/alpha', 'repo-alpha', 'Alpha');
	const launch = Promise.withResolvers<Awaited<ReturnType<DesktopApi['runAgent']>>>();
	const runAgent = vi.fn<DesktopApi['runAgent']>(() => launch.promise);
	const thread = threadRecord('thread-1', 'repo-alpha', 'Existing robot work');
	// SAFETY: fixture IDs are only compared as opaque Convex document identifiers.
	const priorRunId = 'prior-run' as Id<'runs'>;
	// SAFETY: fixture IDs are only compared as opaque Convex document identifiers.
	const nextRunId = 'run-new' as Id<'runs'>;
	const client = createConvexFixtures();
	client.registerPaginatedQuery(api.inbox.list, [thread]);
	client.registerQuery(api.threads.getByThreadId, {
		...thread,
		contextTokens: 0,
		totalTokensProcessed: 0
	});
	client.registerQuery(api.chat.selectedThreadLifecycle, {
		threadId: thread._id,
		phase: 'completed',
		run: { runId: priorRunId, startedAt: 1 }
	});
	await renderApp(
		client,
		createRuntime(
			createDesktopApi({
				listProjectAttachments: async () => [alpha],
				resolveWorkspacePath: async () => alpha,
				runAgent
			})
		)
	);
	await projectTrigger('Alpha');
	fireEvent.click(await screen.findByText('Existing robot work'));
	const composer = screen.getByRole('combobox');
	fireEvent.change(composer, { target: { value: 'Fix the robot' } });
	const send = screen.getByRole('button', { name: 'Send message' });
	await waitFor(() => expect(send).toHaveProperty('disabled', false));
	fireEvent.click(send);
	await waitFor(() => expect(runAgent).toHaveBeenCalledOnce());
	vi.useFakeTimers();

	try {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(composer).toHaveProperty('value', '');
		expect(screen.getByText('Starting agent…')).toBeTruthy();
		expect(send).toHaveProperty('disabled', true);
		expect(runAgent).toHaveBeenCalledOnce();
		await act(async () => {
			launch.resolve({ runId: nextRunId, threadId: thread._id });
			client.registerQuery(api.chat.selectedThreadLifecycle, {
				threadId: thread._id,
				phase: 'running',
				run: { runId: nextRunId, startedAt: Date.now() }
			});
		});
		expect(screen.queryByText('Starting agent…')).toBeNull();
	} finally {
		vi.useRealTimers();
	}
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
	const group = screen.getByRole('group', { name: 'Message composer' });
	expect(within(group).getByRole('alert').textContent).toContain('Local agent unavailable.');
});

it('keeps a sent prompt cleared when returning to a thread before its lifecycle catches up', async () => {
	const { client, thread, launch, runAgent } = await renderThreadLaunch();
	const composer = screen.getByRole('combobox');
	fireEvent.change(composer, { target: { value: 'Fix the robot' } });
	const send = screen.getByRole('button', { name: 'Send message' });
	await waitFor(() => expect(send).toHaveProperty('disabled', false));
	vi.useFakeTimers();
	await act(async () => {
		fireEvent.click(send);
	});
	fireEvent.click(screen.getByText('Other work'));
	await act(async () => {
		launch.resolve({
			// SAFETY: fixture strings are only compared as opaque Convex document ids.
			runId: 'run-new' as Id<'runs'>,
			threadId: thread._id
		});
		await vi.advanceTimersByTimeAsync(31_000);
	});
	fireEvent.click(screen.getByText('Robot work'));
	expect(screen.getByRole('combobox')).toHaveProperty('value', '');
	expect(screen.getByRole('button', { name: 'Send message' })).toHaveProperty('disabled', true);
	expect(screen.queryByRole('alert')).toBeNull();
	await act(async () => {
		client.registerQuery(api.chat.selectedThreadLifecycle, {
			threadId: thread._id,
			phase: 'running',
			// SAFETY: fixture strings are only compared as opaque Convex document ids.
			run: { runId: 'run-new' as Id<'runs'>, startedAt: 1 }
		});
	});
	expect(screen.getByRole('combobox')).toHaveProperty('value', '');
	expect(screen.getByRole('button', { name: 'Stop generation' })).toBeTruthy();
	expect(runAgent).toHaveBeenCalledOnce();
});

it('launches ChatGPT with a gateway model and a connected local account', async () => {
	const alpha = projectAttachment('/work/alpha', 'repo-alpha', 'Alpha');
	const launch = Promise.withResolvers<Awaited<ReturnType<DesktopApi['runAgent']>>>();
	const runAgent = vi.fn<DesktopApi['runAgent']>(() => launch.promise);

	const runtime = createRuntime(
		createDesktopApi({
			listProjectAttachments: async () => [alpha],
			resolveWorkspacePath: async () => alpha,
			fetchChatGptStatus: async () => ({
				accounts: [{ connectionId: 'chatgpt-1', label: 'ChatGPT account', connected: true }],
				activeConnectionId: 'chatgpt-1',
				loginAvailable: true
			}),
			runAgent
		})
	);

	runtime.fetchGatewayModelCatalog = async () => ({
		...modelCatalog,
		models: [
			...modelCatalog.models,
			{ ...modelCatalog.models[0], id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', provider: 'openai' }
		]
	});
	await renderApp(createConvexFixtures(), runtime);
	await projectTrigger('Alpha');
	fireEvent.click(screen.getByRole('button', { name: 'Select provider' }));
	fireEvent.click(await screen.findByRole('button', { name: /ChatGPT Subscription/ }));
	await waitFor(() =>
		expect(screen.getByRole('button', { name: 'Select model' }).textContent).toContain(
			'GPT-6.1 Sol'
		)
	);
	fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Fix the robot' } });
	const send = screen.getByRole('button', { name: 'Send message' });
	await waitFor(() => expect(send).toHaveProperty('disabled', false));
	fireEvent.click(send);
	await waitFor(() =>
		expect(runAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				completionProvider: 'chatgpt',
				selectedModel: 'gpt-6.1-sol',
				prompt: 'Fix the robot'
			})
		)
	);
});

it('enables run-bound Stop after the lifecycle arrives behind a pending question', async () => {
	const alpha = projectAttachment('/work/alpha', 'repo-alpha', 'Alpha');
	const thread = threadRecord('thread-1', 'repo-alpha', 'Fix the robot');

	const question: AgentQuestionSnapshot = {
		threadId: thread._id,
		// SAFETY: fixture strings are only compared as opaque Convex document ids.
		questionId: 'question-1' as Id<'agentQuestions'>,
		question: 'Which board should I target?',
		options: [{ id: 'option-a', label: 'Option A' }],
		status: 'pending',
		sequence: 1,
		createdAt: 1,
		timeoutAt: 1_000_000
	};

	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	const runId = 'run-1' as Id<'runs'>;

	const client = createConvexFixtures();
	client.registerPaginatedQuery(api.inbox.list, [thread]);
	client.registerQuery(api.threads.getByThreadId, {
		...thread,
		contextTokens: undefined,
		totalTokensProcessed: 0
	});
	client.registerQuery(api.agentQuestions.headPendingForThread, question);
	client.registerMutation(api.agentRuntime.requestCancellation, true);

	const mutation = vi.spyOn(client, 'mutation');

	await renderApp(
		client,
		createRuntime(createDesktopApi({ listProjectAttachments: async () => [alpha] }))
	);
	await projectTrigger('Alpha');
	fireEvent.click(await screen.findByText('Fix the robot'));
	expect(await screen.findByText(question.question)).toBeTruthy();
	expect(screen.getByRole('button', { name: 'Submit answer' })).toHaveProperty('disabled', true);
	expect(screen.queryByRole('button', { name: 'Stop generation' })).toBeNull();

	await act(async () => {
		client.registerQuery(api.chat.selectedThreadLifecycle, {
			threadId: thread._id,
			phase: 'waiting_for_input',
			run: { runId, startedAt: 1 }
		});
	});
	fireEvent.click(await screen.findByRole('button', { name: 'Stop generation' }));
	await waitFor(() =>
		expect(mutation).toHaveBeenCalledWith(api.agentRuntime.requestCancellation, { runId })
	);
});

it.each([
	{ error: null, message: 'Failed to stop run.' },
	{ error: new Error('Server unavailable.'), message: 'Server unavailable.' }
])('shows "$message" when stopping a run fails', async ({ error, message }) => {
	const { client, thread } = await renderThreadLaunch();
	await flushPendingWork();

	const mutation = vi.spyOn(client, 'mutation').mockRejectedValueOnce(error);

	await act(async () => {
		client.registerQuery(api.chat.selectedThreadLifecycle, {
			threadId: thread._id,
			phase: 'running',
			// SAFETY: fixture strings are only compared as opaque Convex document ids.
			run: { runId: 'run-1' as Id<'runs'>, startedAt: 1 }
		});
	});
	const stop = await screen.findByRole('button', { name: 'Stop generation' });

	await act(async () => {
		fireEvent.click(stop);
	});

	await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(message));
	expect(mutation).toHaveBeenCalledWith(api.agentRuntime.requestCancellation, { runId: 'run-1' });
});

it('shows a failed run beside the composer and scopes it to the selected thread', async () => {
	const alpha = projectAttachment('/work/alpha', 'repo-alpha', 'Alpha');
	const thread = threadRecord('thread-1', 'repo-alpha', 'Fix the robot');
	const otherThread = threadRecord('thread-2', 'repo-alpha', 'Other work');
	const error = 'ChatGPT usage limit reached. Try again after it resets or switch providers.';
	const client = createConvexFixtures();
	client.registerPaginatedQuery(api.inbox.list, [thread, otherThread]);
	client.registerQuery(api.threads.getByThreadId, {
		...thread,
		contextTokens: undefined,
		totalTokensProcessed: 0
	});
	client.registerQuery(api.chat.selectedThreadLifecycle, {
		threadId: thread._id,
		phase: 'failed',
		// SAFETY: the fixture only compares run ids as opaque Convex document ids.
		run: { runId: 'run-1' as Id<'runs'>, startedAt: 1, lastError: error }
	});
	await renderApp(
		client,
		createRuntime(createDesktopApi({ listProjectAttachments: async () => [alpha] }))
	);
	await projectTrigger('Alpha');
	fireEvent.click(await screen.findByText('Fix the robot'));
	const composer = await screen.findByRole('group', { name: 'Message composer' });
	expect((await within(composer).findByRole('alert')).textContent).toContain(error);
	expect(screen.getByRole('button', { name: 'Continue working' })).toBeTruthy();

	fireEvent.click(await screen.findByText('Other work'));
	await waitFor(() => expect(within(composer).queryByRole('alert')).toBeNull());

	fireEvent.click(await screen.findByText('Fix the robot'));
	expect((await within(composer).findByRole('alert')).textContent).toContain(error);
	await act(async () => {
		client.registerQuery(api.chat.selectedThreadLifecycle, {
			threadId: thread._id,
			phase: 'running',
			// SAFETY: the fixture only compares run ids as opaque Convex document ids.
			run: { runId: 'run-2' as Id<'runs'>, startedAt: Date.now() }
		});
	});
	expect(within(composer).getByRole('button', { name: 'Stop generation' })).toBeTruthy();
});

it('shows reconnecting beside an empty selected conversation and clears it on recovery', async () => {
	const alpha = projectAttachment('/work/alpha', 'repo-alpha', 'Alpha');
	const thread = threadRecord('thread-1', 'repo-alpha', 'Fix the robot');
	const otherThread = threadRecord('thread-2', 'repo-alpha', 'Other work');
	const client = createConvexFixtures();
	client.registerPaginatedQuery(api.inbox.list, [thread, otherThread]);

	const watchers = new Map<string, Parameters<DesktopApi['watchTranscript']>[1]['onEvent']>();

	let stale = true;
	await renderApp(
		client,
		createRuntime(
			createDesktopApi({
				listProjectAttachments: async () => [alpha],
				fetchTranscriptDisplay: async ({ threadId }) => ({
					...emptyDisplayPage(`replica-${threadId}`),
					stale: threadId === thread._id && stale
				}),
				watchTranscript: (request, handlers) => {
					watchers.set(request.threadId, handlers.onEvent);

					return new Promise<void>(() => {});
				}
			})
		)
	);
	await projectTrigger('Alpha');
	fireEvent.click(await screen.findByText('Fix the robot'));
	const composer = screen.getByRole('group', { name: 'Message composer' });
	expect((await within(composer).findByRole('status')).textContent).toContain(
		'Reconnecting to conversation history.'
	);
	expect(within(composer).getByRole('combobox')).toBeTruthy();

	fireEvent.click(await screen.findByText('Other work'));
	await waitFor(() => expect(within(composer).queryByRole('status')).toBeNull());
	await act(async () => {
		watchers.get(thread._id)?.({ eventType: 'updated', stale: true });
	});
	expect(within(composer).queryByRole('status')).toBeNull();

	fireEvent.click(await screen.findByText('Fix the robot'));
	await within(composer).findByRole('status');
	await act(async () => {
		stale = false;
		watchers.get(thread._id)?.({ eventType: 'updated', stale: false });
	});
	await waitFor(() => expect(within(composer).queryByRole('status')).toBeNull());
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

it('restores a ChatGPT continuation and launches after its connection is confirmed', async () => {
	const alpha = projectAttachment('/work/alpha', 'repo-alpha', 'Alpha');

	const thread = {
		...threadRecord('thread-1', 'repo-alpha', 'Fix the robot'),
		completionProvider: 'chatgpt' as const,
		selectedModel: 'gpt-6.1-sol'
	};

	const otherThread = threadRecord('thread-2', 'repo-alpha', 'Other work');

	const question: AgentQuestionSnapshot = {
		threadId: thread._id,
		// SAFETY: fixture strings are only compared as opaque Convex document ids.
		questionId: 'question-1' as Id<'agentQuestions'>,
		question: 'Which board should I target?',
		options: [{ id: 'option-a', label: 'Option A' }],
		status: 'pending',
		sequence: 1,
		createdAt: 1,
		timeoutAt: 1_000_000
	};

	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	const continuationRunId = 'run-1' as Id<'runs'>;

	const answer = Promise.withResolvers<{
		question: AgentQuestionSnapshot;
		continuation: { runId: Id<'runs'>; prompt: string };
	}>();

	const status = Promise.withResolvers<Awaited<ReturnType<DesktopApi['fetchChatGptStatus']>>>();

	const configuration =
		Promise.withResolvers<FunctionReturnType<typeof api.providerCredentials.getMyConfiguration>>();

	const launch = Promise.withResolvers<Awaited<ReturnType<DesktopApi['runAgent']>>>();
	const runAgent = vi.fn<DesktopApi['runAgent']>(() => launch.promise);
	const client = createConvexFixtures();
	client.handleAction(api.providerCredentials.getMyConfiguration, () => configuration.promise);
	client.registerPaginatedQuery(api.inbox.list, [thread, otherThread]);
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
	client.registerMutation(api.agentQuestions.answer, answer.promise);

	const runtime = createRuntime(
		createDesktopApi({
			listProjectAttachments: async () => [alpha],
			fetchChatGptStatus: () => status.promise,
			runAgent
		})
	);

	runtime.fetchGatewayModelCatalog = async () => ({
		...modelCatalog,
		models: [
			...modelCatalog.models,
			{ ...modelCatalog.models[0], id: thread.selectedModel, provider: 'openai' }
		]
	});
	await renderApp(client, runtime);
	await projectTrigger('Alpha');
	fireEvent.click(await screen.findByText('Fix the robot'));
	fireEvent.click(await screen.findByRole('button', { name: 'Option A' }));
	fireEvent.click(screen.getByRole('button', { name: 'Submit answer' }));
	fireEvent.click(await screen.findByText('Other work'));
	await act(async () => {
		client.registerQuery(api.agentQuestions.headPendingForThread, null);
		client.registerQuery(api.chat.selectedThreadLifecycle, {
			threadId: thread._id,
			phase: 'completed',
			run: { runId: continuationRunId, startedAt: 1 }
		});
		answer.resolve({
			question: { ...question, status: 'answered', answer: { optionId: 'option-a' } },
			continuation: { runId: continuationRunId, prompt: 'Continue with the robot fix' }
		});
	});
	fireEvent.click(await screen.findByText('Fix the robot'));
	await waitFor(() =>
		expect(screen.getByRole('combobox')).toHaveProperty('value', 'Continue with the robot fix')
	);
	await flushPendingWork();
	expect(runAgent).not.toHaveBeenCalled();
	await act(async () => {
		status.resolve({
			accounts: [{ connectionId: 'chatgpt-1', label: 'ChatGPT account', connected: true }],
			activeConnectionId: 'chatgpt-1',
			loginAvailable: true
		});
		configuration.resolve({ openai: false, chatgpt: false, chatgptModelIds: null });
	});
	await waitFor(() =>
		expect(runAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				completionProvider: 'chatgpt',
				selectedModel: thread.selectedModel,
				prompt: 'Continue with the robot fix',
				continuationOfRunId: continuationRunId
			})
		)
	);
});

it('floats logo and settings over a full-width transcript when the sidebar is closed', async () => {
	await renderApp(createConvexFixtures(), createRuntime(createDesktopApi()));
	fireEvent.click((await screen.findAllByRole('button', { name: 'Close sidebar' }))[0]!);
	const layout = document.querySelector('.inbox-layout');
	const controls = document.querySelector<HTMLElement>('.inbox-floating-controls');
	expect(controls).toBeTruthy();
	expect(layout?.classList.contains('sidebar-hidden')).toBe(true);
	const floating = within(controls!);
	expect(floating.getByRole('button', { name: 'Open sidebar' })).toBeTruthy();
	expect(floating.getByRole('button', { name: 'Settings' })).toBeTruthy();
	fireEvent.click(floating.getByRole('button', { name: 'Open sidebar' }));
	expect(layout?.classList.contains('sidebar-hidden')).toBe(false);
	expect(document.querySelector('.inbox-floating-controls')).toBeNull();
});
