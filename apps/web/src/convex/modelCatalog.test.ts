import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@convex/_generated/api';
import catalogFixture from '../../../../contracts/ai-gateway/fixtures/catalog.json';
import { initConvexTest } from './test.setup';

describe('model catalog', () => {
	beforeEach(() => {
		process.env.MODEL_GATEWAY_URL = 'https://preview.gateway.example';
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify(catalogFixture), { status: 200 }))
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		delete process.env.MODEL_GATEWAY_URL;
	});

	it('returns the live catalog', async () => {
		const t = initConvexTest();
		const catalog = await t.action(api.modelCatalog.fetch, {});
		expect(catalog.models.map((model) => model.id)).toEqual([
			'deepseek-v4-pro-0813',
			'gpt-5.6-sol'
		]);
	});

	it('rejects the retired static catalog query', async () => {
		const t = initConvexTest();
		await expect(t.query(api.modelCatalog.get, {})).rejects.toThrow(
			'This Sprocket version is no longer supported. Update to the latest Sprocket release.'
		);
	});
});
