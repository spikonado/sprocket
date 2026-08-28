import { describe, expect, it, vi, afterEach } from 'vitest';
import catalogFixture from '../../../../../contracts/ai-gateway/fixtures/catalog.json';
import { fetchGatewayModelCatalog } from './model-catalog';

describe('gateway model catalog', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('parses GET /api/v1/models into the UI catalog', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify(catalogFixture), { status: 200 }))
		);
		const catalog = await fetchGatewayModelCatalog('https://ai-gateway.spikonado.com');
		expect(catalog.defaultModelId).toBe('deepseek-v4-pro-0813');
		expect(catalog.models.map((model) => model.id)).toEqual([
			'deepseek-v4-pro-0813',
			'gpt-5.6-sol'
		]);
	});
});
