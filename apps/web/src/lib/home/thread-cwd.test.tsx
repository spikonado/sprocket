import { renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useExistingThreadCwd } from './thread-cwd';

it('keeps an existing thread cwd and drops one that no longer exists', async () => {
	const resolveWorkspacePath = vi.fn(async ({ workspacePath }: { workspacePath: string }) => {
		if (workspacePath === '/repo/.worktrees/gone') throw new Error('workspace does not exist');

		return { workspacePath, displayName: 'repo', repositoryKey: 'repo' };
	});

	const api = { resolveWorkspacePath };

	const { result, rerender } = renderHook(({ cwd }) => useExistingThreadCwd(api, cwd), {
		initialProps: { cwd: '/repo/.worktrees/live' }
	});

	await waitFor(() => expect(resolveWorkspacePath).toHaveBeenCalledTimes(1));
	expect(result.current).toBe('/repo/.worktrees/live');

	rerender({ cwd: '/repo/.worktrees/gone' });
	await waitFor(() => expect(result.current).toBeUndefined());
});
