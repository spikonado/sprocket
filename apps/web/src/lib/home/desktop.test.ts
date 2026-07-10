import { describe, expect, it, vi } from 'vitest';
import {
	getViewerQueryArgs,
	launchAgentRun,
	syncAttachedWorkspaceSessions
} from '$lib/home/desktop';
import type { DesktopApi } from '$lib/types/sprocket';

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
			getViewerArgs: () => ({ guestId: 'guest-1' }),
			onError: vi.fn(),
			threadId: 'thread-1' as never,
			prompt: 'Inspect src/lib.rs',
			selectedModel: 'gpt-5.4',
			reasoningEffort: 'medium',
			workspaceSessionId: 'workspace-1' as never
		});

		expect(runAgent).toHaveBeenCalledWith({
			authToken: 'token-1',
			guestId: 'guest-1',
			threadId: 'thread-1',
			prompt: 'Inspect src/lib.rs',
			selectedModel: 'gpt-5.4',
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
			getViewerArgs: () => ({}),
			onError,
			threadId: 'thread-1' as never,
			prompt: 'Inspect src/lib.rs',
			selectedModel: 'gpt-5.4',
			reasoningEffort: 'medium',
			workspaceSessionId: 'workspace-1' as never
		});

		await Promise.resolve();
		await Promise.resolve();

		expect(onError).toHaveBeenCalledWith(launchError);
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

describe('syncAttachedWorkspaceSessions', () => {
	it('combines existing and newly attached sessions through the injected mutation', async () => {
		const heartbeatAttached = vi.fn().mockResolvedValue(undefined);

		await syncAttachedWorkspaceSessions({
			attachedWorkspaceSessionIds: ['workspace-1' as never],
			executorClientId: 'client-1',
			getViewerArgs: () => ({ guestId: 'guest-1' }),
			heartbeatAttached,
			workspaceSessionIds: ['workspace-1' as never, 'workspace-2' as never]
		});

		expect(heartbeatAttached).toHaveBeenCalledWith({
			guestId: 'guest-1',
			clientId: 'client-1',
			workspaceSessionIds: ['workspace-1', 'workspace-2']
		});
	});
});
