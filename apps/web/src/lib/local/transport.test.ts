import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createLocalTransport } from './transport';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('local JSON transport', () => {
	it('returns the server error from failed requests', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ error: 'workspace is unavailable' }, { status: 409 }))
		);

		await expect(
			createLocalTransport('http://127.0.0.1:7731').request('/api/test', z.string())
		).rejects.toThrow('workspace is unavailable');
	});

	it('reports malformed JSON as an unexpected API response', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response('{not json', {
						headers: { 'content-type': 'application/json' }
					})
			)
		);

		await expect(
			createLocalTransport('http://127.0.0.1:7731').request('/api/test', z.string())
		).rejects.toThrow('Local API returned an unexpected response: {not json');
	});
});
