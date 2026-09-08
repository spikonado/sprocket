import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestPackageUpdate, updateLabel, updateStateSchema, type UpdateState } from './updates';

afterEach(() => vi.unstubAllGlobals());

function state(status: UpdateState['status'], version: string | null = '1.1.0'): UpdateState {
	return { status, version, method: 'desktop', currentVersion: '1.0.0', error: null };
}

describe('update action', () => {
	it('stays hidden until an update is known, including background failures', () => {
		for (const status of ['idle', 'unavailable', 'checking', 'error'] as const) {
			expect(updateLabel(state(status, null))).toBeNull();
		}
		expect(updateLabel(state('available'))).toBe('Update available');
		expect(updateLabel(state('error'))).toBe('Retry update');
	});

	it('distinguishes download, restart, and package install completion', () => {
		expect(updateLabel({ ...state('downloading'), progress: 42 })).toBe('Downloading… 42%');
		expect(updateLabel(state('downloaded'))).toBe('Restart to update');
		expect(updateLabel({ ...state('installed'), method: 'package' })).toBe('Update installed');
	});

	it('rejects an unrelated or incompatible local server response', () => {
		expect(updateStateSchema.safeParse({ status: 'ok' }).success).toBe(false);
		expect(updateStateSchema.safeParse(state('available')).success).toBe(true);
	});
});

describe('package update requests', () => {
	it('shows the server explanation when an install is rejected', async () => {
		vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:1234' } });
		vi.stubGlobal('fetch', async () =>
			Response.json({ error: 'Updates must be installed from this machine.' }, { status: 403 })
		);
		await expect(requestPackageUpdate(true)).rejects.toThrow(
			'Updates must be installed from this machine.'
		);
	});

	it('treats a missing route on an older server as unsupported only for checks', async () => {
		vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:1234' } });
		vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
		expect(await requestPackageUpdate(false)).toBeNull();
		await expect(requestPackageUpdate(true)).rejects.toThrow('Update request failed (404)');
	});

	it('uses a credentialed POST for installation and validates its response', async () => {
		vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:1234' } });
		const fetcher = vi
			.fn()
			.mockResolvedValue(Response.json({ ...state('installed'), method: 'package' }));
		vi.stubGlobal('fetch', fetcher);
		expect((await requestPackageUpdate(true))?.status).toBe('installed');
		expect(fetcher).toHaveBeenCalledWith(
			'http://127.0.0.1:1234/api/update/install',
			expect.objectContaining({
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' }
			})
		);
	});
});
