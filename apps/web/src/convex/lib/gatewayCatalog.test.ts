import { describe, expect, it } from 'vitest';
import catalogFixture from '../../../../../contracts/ai-gateway/fixtures/catalog.json';
import { parseGatewayModelsResponse, toGatewayUiCatalog } from '@convex/lib/gatewayCatalog';
import { isJsonValue } from '@convex/lib/json';

describe('gateway catalog contract', () => {
	it('parses the shared GET /api/v1/models fixture', () => {
		expect(isJsonValue(catalogFixture)).toBe(true);
		if (!isJsonValue(catalogFixture)) return;
		const catalog = parseGatewayModelsResponse(catalogFixture);
		expect(catalog.protocolVersion).toBe(1);
		expect(catalog.catalogVersion).toBe('1');
		expect(catalog.defaultModelId).toBe('deepseek-v4-pro-0813');
		expect(catalog.models.map((model) => model.id)).toEqual([
			'deepseek-v4-pro-0813',
			'gpt-5.6-sol'
		]);
		const ui = toGatewayUiCatalog(catalog);
		expect(ui.models.find((model) => model.id === 'deepseek-v4-pro-0813')?.usagePolicy).toBe(
			undefined
		);
		expect(ui.models.find((model) => model.id === 'gpt-5.6-sol')?.usagePolicy).toBeUndefined();
	});

	it('rejects an unsupported protocol version', () => {
		const payload = {
			...catalogFixture,
			sprocket: { ...catalogFixture.sprocket, protocolVersion: 2 }
		};
		expect(isJsonValue(payload)).toBe(true);
		if (!isJsonValue(payload)) return;
		expect(() => parseGatewayModelsResponse(payload)).toThrow(/Unsupported protocol version/);
	});
});
