import { describe, expect, it, vi } from 'vitest';
import {
	createLatestTaskQueue,
	getDesiredAttachedWorkspaceSessionIds,
	getViewerIdentity,
	getViewerQueryArgs,
	launchAgentRun,
	resolveSubmissionId
} from '$lib/home/desktop';
import type { DesktopApi, WorkspaceSessionLocation } from '$lib/types/sprocket';

function createDesktopApi(runAgent: DesktopApi['runAgent']): DesktopApi {
	return {
		browseFilesystem: vi.fn(),
		workspaceOverviewForPath: vi.fn(),
		listWorkspaceSessions: vi.fn(),
		attachWorkspaceSession: vi.fn(),
		getWorkspaceSessionOverview: vi.fn(),
		runAgent
	} as unknown as DesktopApi;
}

describe('launchAgentRun', () => {
	it('starts a desktop run with viewer args and auth token', () => {
		const runAgent = vi.fn().mockResolvedValue(undefined);
		const desktopApi = createDesktopApi(runAgent);

		launchAgentRun({
			authToken: 'token-1',
			desktopApi,
			onError: vi.fn(),
			threadId: 'thread-1' as never,
			prompt: 'Inspect src/lib.rs',
			selectedModel: 'gpt-5.4',
			reasoningEffort: 'medium',
			submissionId: 'submission-1',
			viewerArgs: { guestId: 'guest-1' },
			workspaceSessionId: 'workspace-1' as never
		});

		expect(runAgent).toHaveBeenCalledWith({
			authToken: 'token-1',
			guestId: 'guest-1',
			threadId: 'thread-1',
			prompt: 'Inspect src/lib.rs',
			selectedModel: 'gpt-5.4',
			submissionId: 'submission-1',
			reasoningEffort: 'medium',
			workspaceSessionId: 'workspace-1'
		});
	});

	it('reports asynchronous launch failures through onError', async () => {
		const launchError = new Error('desktop launch failed');
		const onError = vi.fn();
		const desktopApi = createDesktopApi(vi.fn().mockRejectedValue(launchError));

		launchAgentRun({
			desktopApi,
			onError,
			threadId: 'thread-1' as never,
			prompt: 'Inspect src/lib.rs',
			selectedModel: 'gpt-5.4',
			reasoningEffort: 'medium',
			submissionId: 'submission-1',
			viewerArgs: {},
			workspaceSessionId: 'workspace-1' as never
		});

		await Promise.resolve();
		await Promise.resolve();

		expect(onError).toHaveBeenCalledWith(launchError);
	});
});

describe('getViewerIdentity', () => {
	it('derives a stable identity from the authenticated user or guest', () => {
		expect(getViewerIdentity({ id: 'user-1' }, 'guest-1')).toBe('user:user-1');
		expect(getViewerIdentity(null, 'guest-1')).toBe('guest:guest-1');
		expect(getViewerIdentity(null, null)).toBeNull();
	});
});

describe('resolveSubmissionId', () => {
	it('reuses an uncertain submission only when its restored prompt is unchanged', () => {
		const recoveredSubmission = {
			prompt: 'Inspect the robot',
			reasoningEffort: 'medium' as const,
			selectedModel: 'gpt-5.4' as const,
			submissionId: 'recovered-id'
		};

		expect(
			resolveSubmissionId({
				newSubmissionId: 'new-id',
				prompt: 'Inspect the robot',
				reasoningEffort: 'medium',
				recoveredSubmission,
				selectedModel: 'gpt-5.4'
			})
		).toBe('recovered-id');
		expect(
			resolveSubmissionId({
				newSubmissionId: 'new-id',
				prompt: 'Inspect and fix the robot',
				reasoningEffort: 'medium',
				recoveredSubmission,
				selectedModel: 'gpt-5.4'
			})
		).toBe('new-id');
		expect(
			resolveSubmissionId({
				newSubmissionId: 'new-id',
				prompt: 'Inspect the robot',
				reasoningEffort: 'high',
				recoveredSubmission,
				selectedModel: 'gpt-5.4'
			})
		).toBe('new-id');
	});
});

describe('getViewerQueryArgs', () => {
	it('waits for Convex to confirm an authenticated user', () => {
		expect(
			getViewerQueryArgs({
				authenticatedUser: { id: 'user-1' },
				convexIsAuthenticated: false,
				convexIsLoading: true,
				guestSessionId: 'guest-1'
			})
		).toBe('skip');

		expect(
			getViewerQueryArgs({
				authenticatedUser: { id: 'user-1' },
				convexIsAuthenticated: true,
				convexIsLoading: false,
				guestSessionId: 'guest-1'
			})
		).toEqual({});
	});

	it('only uses guest identity after authenticated state has cleared', () => {
		expect(
			getViewerQueryArgs({
				authenticatedUser: null,
				convexIsAuthenticated: true,
				convexIsLoading: false,
				guestSessionId: 'guest-1'
			})
		).toBe('skip');

		expect(
			getViewerQueryArgs({
				authenticatedUser: null,
				convexIsAuthenticated: false,
				convexIsLoading: false,
				guestSessionId: 'guest-1'
			})
		).toEqual({ guestId: 'guest-1' });
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
		let releaseFirst: (() => void) | undefined;
		const writeError = new Error('offline');
		const values: string[] = [];
		const queue = createLatestTaskQueue(async (value: string) => {
			values.push(value);
			if (value === 'first') {
				await new Promise<void>((resolve) => {
					releaseFirst = resolve;
				});
				return;
			}

			throw writeError;
		});
		const first = queue.enqueue('first');
		const superseded = queue.enqueue('superseded');
		const latest = queue.enqueue('latest');
		const supersededFailure = expect(superseded).rejects.toBe(writeError);
		const latestFailure = expect(latest).rejects.toBe(writeError);

		releaseFirst?.();
		await first;
		await Promise.all([supersededFailure, latestFailure]);
		expect(values).toEqual(['first', 'latest']);
	});

	it('cancels pending requests without affecting an in-flight write', async () => {
		let releaseFirst: (() => void) | undefined;
		const values: string[] = [];
		const queue = createLatestTaskQueue(async (value: string) => {
			values.push(value);
			if (value === 'first') {
				await new Promise<void>((resolve) => {
					releaseFirst = resolve;
				});
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
		releaseFirst?.();
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
