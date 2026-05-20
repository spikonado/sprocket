import { describe, expect, it, vi } from 'vitest';
import { launchAgentRun } from '$lib/home/desktop';
import type { DesktopApi } from '$lib/types/sprocket';

function createDesktopApi(runAgent: DesktopApi['runAgent']): DesktopApi {
	return {
		chooseWorkspace: vi.fn(),
		listWorkspaceSessions: vi.fn(),
		attachWorkspaceSession: vi.fn(),
		getWorkspaceSessionOverview: vi.fn(),
		executeWorkspaceTool: vi.fn(),
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
			deploymentUrl: 'https://example.convex.cloud',
			getViewerArgs: () => ({ guestId: 'guest-1' }),
			onError: vi.fn(),
			runId: 'run-1',
			workspaceSessionId: 'workspace-1' as never
		});

		expect(runAgent).toHaveBeenCalledWith({
			authToken: 'token-1',
			deploymentUrl: 'https://example.convex.cloud',
			guestId: 'guest-1',
			runId: 'run-1',
			workspaceSessionId: 'workspace-1'
		});
	});

	it('reports asynchronous launch failures through onError', async () => {
		const launchError = new Error('desktop launch failed');
		const onError = vi.fn();
		const desktopApi = createDesktopApi(vi.fn().mockRejectedValue(launchError));

		launchAgentRun({
			desktopApi,
			deploymentUrl: 'https://example.convex.cloud',
			getViewerArgs: () => ({}),
			onError,
			runId: 'run-1',
			workspaceSessionId: 'workspace-1' as never
		});

		await Promise.resolve();
		await Promise.resolve();

		expect(onError).toHaveBeenCalledWith(launchError);
	});
});
