import { expect, it, vi } from 'vitest';
import { loadRuntimeConfig } from './runtime-config';

it('loads the installed runtime configuration without build-time environment values', async () => {
	const config = { env: { PUBLIC_CONVEX_URL: 'https://test.convex.cloud' }, machine: true };
	const fetchConfig = vi.fn<typeof fetch>(async () => Response.json(config));
	await expect(loadRuntimeConfig(fetchConfig)).resolves.toEqual(config);
	expect(fetchConfig).toHaveBeenCalledWith('/api/config');
});

it('keeps hosted configurations without a machine flag valid', async () => {
	await expect(loadRuntimeConfig(async () => Response.json({ env: {} }))).resolves.toEqual({
		env: {},
		machine: false
	});
});

it('reports an unusable runtime configuration', async () => {
	await expect(loadRuntimeConfig(async () => Response.json({ env: null }))).rejects.toThrow(
		'Failed to load Sprocket runtime config.'
	);
	await expect(loadRuntimeConfig(async () => new Response(null, { status: 503 }))).rejects.toThrow(
		'Failed to load Sprocket runtime config.'
	);
});
