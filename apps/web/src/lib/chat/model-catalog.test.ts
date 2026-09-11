import { describe, expect, it, vi, afterEach } from 'vitest';
import { fastModeAccessForModelAndTier, fetchGatewayModelCatalog } from './model-catalog';

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
				serviceTiers: ['standard', 'fast']
			}
		],
		tierAllowedModels: {
			free: ['model-small'],
			pro: ['model-small'],
			admin: ['model-small']
		},
		tierAllowedServiceTiers: {
			free: ['standard'],
			pro: ['standard', 'fast'],
			admin: ['standard', 'fast']
		},
		modelLockUpgradeMessage: 'Upgrade to use this model',
		serviceTierLockUpgradeMessage: 'Upgrade to use Fast mode'
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
		expect(catalog.models[0].supportsFastMode).toBe(true);
		expect(catalog.tierAllowsFastMode).toEqual({ free: false, pro: true, admin: true });
		expect(fastModeAccessForModelAndTier(catalog, 'free', catalog.models[0])).toBe('locked');
		expect(fastModeAccessForModelAndTier(catalog, 'pro', catalog.models[0])).toBe('available');
	});

	it('does not expose Fast mode when the model omits the fast gateway tier', async () => {
		const payload = structuredClone(catalogPayload);
		payload.sprocket.models[0].serviceTiers = ['standard'];
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }))
		);

		const catalog = await fetchGatewayModelCatalog('https://ai-gateway.spikonado.com');
		expect(catalog.models[0].supportsFastMode).toBe(false);
		expect(fastModeAccessForModelAndTier(catalog, 'pro', catalog.models[0])).toBe('unsupported');
	});
});
