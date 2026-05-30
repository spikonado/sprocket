import { describe, expect, it, vi } from 'vitest';
import { launchAgentRun } from '$lib/home/desktop';
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
