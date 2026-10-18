import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestPackageUpdate, restartPackageUpdate, type UpdateState } from './updates';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function state(status: UpdateState['status'], version: string | null = '1.1.0'): UpdateState {
	return { status, version, method: 'desktop', currentVersion: '1.0.0', error: null };
}

describe('package update requests', () => {
	it('waits through the old server and a connection outage before accepting the updated server', async () => {
		vi.useFakeTimers();
		const reload = vi.fn();
		vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:1234', reload } });

		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 204 }))
			.mockResolvedValueOnce(Response.json({ version: '1.0.0' }))
			.mockRejectedValueOnce(new TypeError('Connection refused'))
			.mockResolvedValueOnce(Response.json({ version: '1.1.0' }));

		vi.stubGlobal('fetch', fetcher);
		const restart = restartPackageUpdate('1.1.0');
		await vi.advanceTimersByTimeAsync(3_000);
		await restart;
		expect(fetcher).toHaveBeenNthCalledWith(
			1,
			'http://127.0.0.1:1234/api/update/restart',
			expect.objectContaining({ method: 'POST', credentials: 'include' })
		);
		expect(fetcher).toHaveBeenCalledTimes(4);
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it('explains how to recover if the replacement server never starts', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:1234' } });
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce(new Response(null, { status: 204 }))
				.mockImplementation(async () => Response.json({ version: '1.0.0' }))
		);

		const result = expect(restartPackageUpdate('1.1.0')).rejects.toThrow('Launch Sprocket again');

		await vi.advanceTimersByTimeAsync(90_000);
		await result;
	});

	it('shows the server explanation when an install is rejected', async () => {
		vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:1234' } });
		vi.stubGlobal('fetch', async () =>
			Response.json({ error: 'Updates must be installed from this machine.' }, { status: 403 })
		);
		await expect(requestPackageUpdate(true)).rejects.toThrow(
			'Updates must be installed from this machine.'
		);
	});

	it('reports a missing update route as an error', async () => {
		vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:1234' } });
		vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
		await expect(requestPackageUpdate(false)).rejects.toThrow('Update request failed (404)');
		await expect(requestPackageUpdate(true)).rejects.toThrow('Update request failed (404)');
	});

	it.each([
		'http://127.0.0.1:1234',
		'http://192.168.1.10:7731',
		'http://100.64.0.10:7731',
		'https://sprocket.tailnet.ts.net'
	])('uses the current server origin %s for credentialed update requests', async (origin) => {
		vi.stubGlobal('window', { location: { origin } });

		const fetcher = vi.fn(async () => Response.json({ ...state('installed'), method: 'package' }));

		vi.stubGlobal('fetch', fetcher);
		expect((await requestPackageUpdate(false))?.status).toBe('installed');
		expect(fetcher).toHaveBeenNthCalledWith(
			1,
			`${origin}/api/update`,
			expect.objectContaining({ method: 'GET', credentials: 'include' })
		);
		expect((await requestPackageUpdate(true))?.status).toBe('installed');
		expect(fetcher).toHaveBeenNthCalledWith(
			2,
			`${origin}/api/update/install`,
			expect.objectContaining({
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' }
			})
		);
	});
});
