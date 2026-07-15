import { describe, expect, it, vi } from 'vitest';
import {
	createLatestTaskQueue,
	getDesiredAttachedWorkspaceSessionIds,
	isRunBlockingAgentLaunch,
	launchAgentRun,
	resolveDraftRunSubmissionId,
	resolveSubmissionId
} from '$lib/home/desktop';
import type {
	AgentAuthStatus,
	DesktopApi,
	RunState,
	WorkspaceSessionLocation
} from '$lib/types/sprocket';

const recoveredSubmission = {
	prompt: 'Inspect the robot',
	reasoningEffort: 'medium' as const,
	selectedModel: 'gpt-5.4' as const,
	submissionId: 'recovered-id'
};

function createDesktopApi(runAgent: DesktopApi['runAgent']): DesktopApi {
	return {
		browseFilesystem: vi.fn(),
		workspaceOverviewForPath: vi.fn(),
		listWorkspaceSessions: vi.fn(),
		attachWorkspaceSession: vi.fn(),
		getWorkspaceSessionOverview: vi.fn(),
		runAgent,
		waitForAgentAuthRefresh: vi.fn().mockResolvedValue('complete'),
		refreshAgentAuth: vi.fn()
	} as unknown as DesktopApi;
}

function launchArgs(
	overrides: Partial<Parameters<typeof launchAgentRun>[0]> &
		Pick<Parameters<typeof launchAgentRun>[0], 'desktopApi'>
): Parameters<typeof launchAgentRun>[0] {
	return {
		authToken: 'token-1',
		expectedUserId: 'user-1',
		getAccessToken: vi.fn(),
		getCurrentUserId: () => 'user-1',
		onError: vi.fn(),
		onStarted: vi.fn(),
		threadId: 'thread-1' as never,
		prompt: 'Inspect src/lib.rs',
		selectedModel: 'gpt-5.4',
		reasoningEffort: 'medium',
		submissionId: 'submission-1',
		workspaceSessionId: 'workspace-1' as never,
		...overrides
	};
}

function resolveRecoveredSubmission(
	overrides: Partial<Parameters<typeof resolveSubmissionId>[0]> = {}
) {
	return resolveSubmissionId({
		latestRun: null,
		newSubmissionId: 'new-id',
		prompt: recoveredSubmission.prompt,
		reasoningEffort: recoveredSubmission.reasoningEffort,
		recoveredSubmission,
		selectedModel: recoveredSubmission.selectedModel,
		...overrides
	});
}

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((settle, fail) => {
		resolve = settle;
		reject = fail;
	});
	return { promise, reject, resolve };
}

describe('launchAgentRun', () => {
	it('acknowledges a durably created desktop run', async () => {
		const runAgent = vi.fn().mockResolvedValue({ runId: 'run-1' });
		const desktopApi = createDesktopApi(runAgent);
		const onStarted = vi.fn();

		launchAgentRun(launchArgs({ desktopApi, onStarted }));

		expect(runAgent).toHaveBeenCalledWith({
			authSessionId: expect.any(String),
			authToken: 'token-1',
			threadId: 'thread-1',
			prompt: 'Inspect src/lib.rs',
			selectedModel: 'gpt-5.4',
			submissionId: 'submission-1',
			reasoningEffort: 'medium',
			workspaceSessionId: 'workspace-1'
		});
		await vi.waitFor(() => {
			expect(onStarted).toHaveBeenCalledWith('run-1');
		});
	});

	it('reports asynchronous launch failures through onError', async () => {
		const launchError = new Error('desktop launch failed');
		const onError = vi.fn();
		const desktopApi = createDesktopApi(vi.fn().mockRejectedValue(launchError));

		launchAgentRun(launchArgs({ desktopApi, onError }));

		await vi.waitFor(() => {
			expect(onError).toHaveBeenCalledWith(launchError);
		});
	});

	it('force-refreshes the access token when the running agent requests one', async () => {
		const desktopApi = createDesktopApi(vi.fn().mockResolvedValue({ runId: 'run-1' }));
		vi.mocked(desktopApi.waitForAgentAuthRefresh)
			.mockResolvedValueOnce('refreshRequired')
			.mockResolvedValueOnce('complete');
		const getAccessToken = vi.fn().mockResolvedValue('token-2');

		launchAgentRun(launchArgs({ desktopApi, getAccessToken }));

		await vi.waitFor(() => {
			expect(desktopApi.refreshAgentAuth).toHaveBeenCalledWith(expect.any(String), 'token-2');
		});
		expect(getAccessToken).toHaveBeenCalledWith({ forceRefreshToken: true });
	});

	it('treats a missing auth session as complete after launch acknowledgement', async () => {
		const authStatus = deferred<AgentAuthStatus>();
		const desktopApi = createDesktopApi(vi.fn().mockResolvedValue({ runId: 'run-1' }));
		vi.mocked(desktopApi.waitForAgentAuthRefresh).mockReturnValue(authStatus.promise);
		const onError = vi.fn();
		const onStarted = vi.fn();

		launchAgentRun(launchArgs({ desktopApi, onError, onStarted }));

		await vi.waitFor(() => expect(onStarted).toHaveBeenCalledWith('run-1'));
		authStatus.resolve('notFound');
		await authStatus.promise;
		await Promise.resolve();

		expect(onError).not.toHaveBeenCalled();
	});

	it('keeps polling while launch is pending and the auth session is not ready yet', async () => {
		vi.useFakeTimers();
		try {
			const launch = deferred<{ runId: never }>();
			const desktopApi = createDesktopApi(vi.fn().mockReturnValue(launch.promise));
			vi.mocked(desktopApi.waitForAgentAuthRefresh).mockResolvedValue('notFound');
			const onError = vi.fn();
			const onStarted = vi.fn();

			launchAgentRun(launchArgs({ desktopApi, onError, onStarted }));
			await vi.advanceTimersByTimeAsync(1_000);
			expect(onError).not.toHaveBeenCalled();
			expect(vi.mocked(desktopApi.waitForAgentAuthRefresh).mock.calls.length).toBeGreaterThan(1);

			launch.resolve({ runId: 'run-1' as never });
			await vi.waitFor(() => expect(onStarted).toHaveBeenCalledWith('run-1'));
			expect(onError).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it('surfaces the launch error when the auth session never appears', async () => {
		vi.useFakeTimers();
		try {
			const launch = deferred<{ runId: never }>();
			const desktopApi = createDesktopApi(vi.fn().mockReturnValue(launch.promise));
			vi.mocked(desktopApi.waitForAgentAuthRefresh).mockResolvedValue('notFound');
			const onError = vi.fn();
			const launchError = new Error('desktop launch failed');

			launchAgentRun(launchArgs({ desktopApi, onError }));
			await vi.advanceTimersByTimeAsync(500);
			launch.reject(launchError);
			await vi.waitFor(() => {
				expect(onError).toHaveBeenCalledWith(launchError);
			});
			expect(onError).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('resolveSubmissionId', () => {
	it('reuses an uncertain submission only when its restored prompt is unchanged', () => {
		expect(resolveRecoveredSubmission()).toBe('recovered-id');
		expect(resolveRecoveredSubmission({ prompt: 'Inspect and fix the robot' })).toBe('new-id');
		expect(resolveRecoveredSubmission({ reasoningEffort: 'high' })).toBe('new-id');
	});

	it('uses a fresh id when the visible latest submission has finished or supersedes recovery', () => {
		expect(
			resolveRecoveredSubmission({
				latestRun: { status: 'failed', submissionId: 'recovered-id' }
			})
		).toBe('new-id');
		expect(
			resolveRecoveredSubmission({
				latestRun: { status: 'queued', submissionId: 'recovered-id' }
			})
		).toBe('recovered-id');
		expect(
			resolveRecoveredSubmission({
				latestRun: { status: 'queued', submissionId: 'newer-id' }
			})
		).toBe('new-id');
	});
});

describe('resolveDraftRunSubmissionId', () => {
	it.each(['completed', 'failed', 'cancelled'] as const)(
		'uses a fresh run submission after draft creation reveals a %s run',
		(submissionRunStatus) => {
			expect(
				resolveDraftRunSubmissionId({
					freshSubmissionId: 'fresh-id',
					submissionRunStatus,
					threadSubmissionId: 'recovered-id'
				})
			).toBe('fresh-id');
		}
	);

	it.each([null, 'queued', 'running', 'awaiting_executor'] as const)(
		'reuses the draft submission when its run is %s',
		(submissionRunStatus) => {
			expect(
				resolveDraftRunSubmissionId({
					freshSubmissionId: 'fresh-id',
					submissionRunStatus,
					threadSubmissionId: 'recovered-id'
				})
			).toBe('recovered-id');
		}
	);
});

describe('isRunBlockingAgentLaunch', () => {
	it('blocks queued and actively leased runs', () => {
		const run = (
			status: RunState['status'],
			claimExpiresAt?: number
		): Pick<RunState, 'status' | 'claimExpiresAt'> => ({
			status,
			...(claimExpiresAt === undefined ? {} : { claimExpiresAt })
		});

		expect(isRunBlockingAgentLaunch(run('queued'), 100)).toBe(true);
		expect(isRunBlockingAgentLaunch(run('running', 101), 100)).toBe(true);
		expect(isRunBlockingAgentLaunch(run('awaiting_executor', 100), 100)).toBe(false);
	});
});

describe('createLatestTaskQueue', () => {
	it('settles coalesced requests with the retained latest write', async () => {
		const releases: Array<() => void> = [];
		const values: string[] = [];
		const queue = createLatestTaskQueue(async (value: string) => {
			values.push(value);
			await new Promise<void>((resolve) => releases.push(resolve));
		});

		const first = queue.enqueue('old-viewer');
		const superseded = queue.enqueue('superseded');
		const latest = queue.enqueue('new-viewer');
		expect(superseded).toBe(latest);
		let coalescedSettled = false;
		void superseded.then(() => {
			coalescedSettled = true;
		});

		expect(values).toEqual(['old-viewer']);
		releases.shift()?.();
		await first;
		expect(values).toEqual(['old-viewer', 'new-viewer']);
		expect(coalescedSettled).toBe(false);
		releases.shift()?.();
		await Promise.all([superseded, latest]);
		expect(coalescedSettled).toBe(true);
	});

	it('rejects every coalesced request when the retained latest write fails', async () => {
		const firstGate = deferred();
		const writeError = new Error('offline');
		const values: string[] = [];
		const queue = createLatestTaskQueue(async (value: string) => {
			values.push(value);
			if (value === 'first') {
				await firstGate.promise;
				return;
			}

			throw writeError;
		});
		const first = queue.enqueue('first');
		const superseded = queue.enqueue('superseded');
		const latest = queue.enqueue('latest');
		const supersededFailure = expect(superseded).rejects.toBe(writeError);
		const latestFailure = expect(latest).rejects.toBe(writeError);

		firstGate.resolve();
		await first;
		await Promise.all([supersededFailure, latestFailure]);
		expect(values).toEqual(['first', 'latest']);
	});

	it('cancels pending requests without affecting an in-flight write', async () => {
		const firstGate = deferred();
		const values: string[] = [];
		const queue = createLatestTaskQueue(async (value: string) => {
			values.push(value);
			if (value === 'first') {
				await firstGate.promise;
			}
		});
		const first = queue.enqueue('first');
		const superseded = queue.enqueue('superseded');
		const latest = queue.enqueue('latest');
		const supersededCancellation = expect(superseded).rejects.toThrow('Pending task was canceled.');
		const latestCancellation = expect(latest).rejects.toThrow('Pending task was canceled.');

		queue.cancelPending();
		await Promise.all([supersededCancellation, latestCancellation]);
		expect(values).toEqual(['first']);
		const replacement = queue.enqueue('replacement');
		firstGate.resolve();
		await Promise.all([first, replacement]);
		expect(values).toEqual(['first', 'replacement']);
	});
});

describe('getDesiredAttachedWorkspaceSessionIds', () => {
	it('includes only locally available sessions belonging to the current viewer', () => {
		const location = (
			workspaceSessionId: string,
			availability: WorkspaceSessionLocation['availability'] = 'available'
		): WorkspaceSessionLocation => ({
			workspaceSessionId: workspaceSessionId as never,
			workspacePath: `/workspaces/${workspaceSessionId}`,
			availability,
			lastValidatedAt: 1,
			lastUsedAt: 1
		});

		expect(
			getDesiredAttachedWorkspaceSessionIds(
				[location('local'), location('old-viewer'), location('confirmed', 'unavailable')],
				['local' as never, 'confirmed' as never]
			)
		).toEqual(['local']);
	});
});
