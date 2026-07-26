import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createLocalClient,
	readWorkspaceLaunchFromHash,
	workspaceLaunchHash
} from '$lib/local/client';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('workspace launch fragments', () => {
	it('round-trips paths containing URL metacharacters', () => {
		const workspacePath = '/robots/arm & gripper';
		const hash = workspaceLaunchHash(workspacePath);
		vi.stubGlobal('window', { location: { hash } });

		expect(hash).toBe('#workspace=%2Frobots%2Farm+%26+gripper');
		expect(readWorkspaceLaunchFromHash()).toBe(workspacePath);
	});
});

describe('command session requests', () => {
	it('lists and stops a thread command through the local API', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify([
						{
							sessionId: 'session/1',
							command: 'sleep 5',
							cwd: '/workspace',
							running: true
						}
					]),
					{ headers: { 'content-type': 'application/json' } }
				)
			)
			.mockResolvedValueOnce(new Response(null, { status: 204 }));
		vi.stubGlobal('fetch', fetchMock);
		const client = createLocalClient('http://localhost:7731');

		await expect(client.listCommandSessions('thread/1' as never)).resolves.toEqual([
			expect.objectContaining({ sessionId: 'session/1', running: true })
		]);
		await expect(client.stopCommand('thread/1' as never, 'session/1')).resolves.toBeUndefined();

		expect(fetchMock).toHaveBeenNthCalledWith(
			1,
			'http://localhost:7731/api/agent/commands/thread%2F1',
			expect.objectContaining({ credentials: 'include' })
		);
		expect(fetchMock).toHaveBeenNthCalledWith(
			2,
			'http://localhost:7731/api/agent/commands/thread%2F1/session%2F1',
			expect.objectContaining({ method: 'DELETE', credentials: 'include' })
		);
	});
});
