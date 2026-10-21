import { renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { LocalResponseError } from '$lib/local/transport';
import { useExistingThreadCwd } from './thread-cwd';

it('drops a thread cwd only while the machine reports it missing', async () => {
	let goneExists = false;

	const resolveWorkspacePath = vi.fn(async ({ workspacePath }: { workspacePath: string }) => {
		if (workspacePath === '/repo/.worktrees/offline') throw new TypeError('Failed to fetch');

		if (workspacePath === '/repo/.worktrees/gone' && !goneExists) {
			throw new LocalResponseError('workspace does not exist', 400);
		}

		return { workspacePath, displayName: 'repo', repositoryKey: 'repo' };
	});

	const api = { resolveWorkspacePath };

	const { result, rerender } = renderHook(
		({ cwd, status }) => useExistingThreadCwd(api, cwd, status),
		{ initialProps: { cwd: '/repo/.worktrees/offline', status: 'completed' } }
	);

	await waitFor(() => expect(resolveWorkspacePath).toHaveBeenCalledTimes(1));
	expect(result.current).toBe('/repo/.worktrees/offline');

	rerender({ cwd: '/repo/.worktrees/gone', status: 'running' });
	await waitFor(() => expect(result.current).toBeUndefined());

	goneExists = true;
	rerender({ cwd: '/repo/.worktrees/gone', status: 'completed' });
	await waitFor(() => expect(result.current).toBe('/repo/.worktrees/gone'));
});
