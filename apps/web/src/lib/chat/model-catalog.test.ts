import { describe, expect, it, vi, afterEach } from 'vitest';
import { fetchGatewayModelCatalog } from './model-catalog';

const catalogPayload = {
	sprocket: {
		protocolVersion: 1,
		catalogVersion: 'test',
		defaultModelId: 'model-small',
		defaultReasoningEffort: 'medium',
		defaultServiceTier: 'standard',
		models: [
			{
				id: 'model-small',
				label: 'Model Small',
				provider: 'provider-one',
				supportsImages: false,
				contextWindowTokens: 100_000,
				autoCompactTokenLimit: 80_000,
				reasoningEfforts: ['low', 'medium'],
				defaultReasoningEffort: 'medium',
				serviceTiers: ['standard']
			}
		],
		tierAllowedModels: {
			free: ['model-small'],
			pro: ['model-small'],
			admin: ['model-small']
		},
		tierAllowedServiceTiers: {
			free: ['standard'],
			pro: ['standard'],
			admin: ['standard']
		},
		modelLockUpgradeMessage: 'Upgrade to use this model',
		serviceTierLockUpgradeMessage: 'Upgrade to use this service tier'
	}
};

describe('gateway model catalog', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('maps gateway autoCompactTokenLimit onto autoHandoffTokenLimit', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify(catalogPayload), { status: 200 }))
		);
		const catalog = await fetchGatewayModelCatalog('https://ai-gateway.spikonado.com');
		expect(catalog.models.map((model) => model.autoHandoffTokenLimit)).toEqual(
			catalogPayload.sprocket.models.map((model) => model.autoCompactTokenLimit)
		);
		expect(catalog.models[0]).not.toHaveProperty('autoCompactTokenLimit');
	});
});
