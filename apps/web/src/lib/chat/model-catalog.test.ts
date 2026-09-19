import { describe, expect, it, vi, afterEach } from 'vitest';
import {
	fastModeAccessForModelAndTier,
	fetchGatewayModelCatalog,
	isModelAllowedForTier,
	showsReasoningControl
} from './model-catalog';

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
			go: ['model-small'],
			budget: ['model-small']
		},
		tierAllowedServiceTiers: {
			free: ['standard'],
			go: ['standard', 'fast'],
			budget: ['standard', 'fast']
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
		expect(catalog.tierAllowsFastMode).toEqual({
			free: false,
			go: true,
			budget: true
		});
		expect(fastModeAccessForModelAndTier(catalog, 'free', catalog.models[0])).toBe('locked');
		expect(fastModeAccessForModelAndTier(catalog, 'go', catalog.models[0])).toBe('available');
		expect(fastModeAccessForModelAndTier(catalog, 'budget', catalog.models[0])).toBe('available');
	});

	it('allows everything for tiers missing from the catalog', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify(catalogPayload), { status: 200 }))
		);
		const catalog = await fetchGatewayModelCatalog('https://ai-gateway.spikonado.com');
		expect(isModelAllowedForTier(catalog, 'enterprise', 'model-small')).toBe(true);
		expect(isModelAllowedForTier(catalog, 'enterprise', 'model-unknown')).toBe(false);
		expect(fastModeAccessForModelAndTier(catalog, 'enterprise', catalog.models[0])).toBe(
			'available'
		);
	});

	it('rejects catalogs with empty permission maps', async () => {
		const base = structuredClone(catalogPayload);
		// SAFETY: test-only payload exercising the empty-maps rejection path.
		const payload = {
			sprocket: {
				...base.sprocket,
				tierAllowedModels: {} as Record<string, string[]>,
				tierAllowedServiceTiers: {} as Record<string, string[]>
			}
		};
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }))
		);
		await expect(fetchGatewayModelCatalog('https://ai-gateway.spikonado.com')).rejects.toThrow(
			'Model catalog is unavailable.'
		);
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

describe('reasoning controls', () => {
	it('hides the internal no-reasoning marker but keeps fixed named efforts visible', () => {
		const model = {
			id: 'model',
			label: 'Model',
			provider: 'provider',
			supportsImages: false,
			contextWindowTokens: 100_000,
			autoHandoffTokenLimit: 80_000,
			reasoningEfforts: ['none'],
			defaultReasoningEffort: 'none',
			supportsFastMode: false
		};
		expect(showsReasoningControl(model)).toBe(false);
		expect(
			showsReasoningControl({
				...model,
				reasoningEfforts: ['max'],
				defaultReasoningEffort: 'max'
			})
		).toBe(true);
	});
});
