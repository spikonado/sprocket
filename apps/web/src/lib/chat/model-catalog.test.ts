import { describe, expect, it, vi, afterEach } from 'vitest';
import { availableServiceTiers, isDirectOpenAIByok, normalizeServiceTier } from './service-tier';
import {
	fetchGatewayModelCatalog,
	resolveCatalogModel,
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
				serviceTiers: ['standard', 'fast'],
				byokServiceTiers: ['ultrafast']
			}
		]
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
		expect(catalog.models[0].byokServiceTiers).toEqual(['ultrafast']);
		expect(catalog).not.toHaveProperty('tierAllowsFastMode');
	});

	it('falls back to the catalog default rather than the first model', async () => {
		const payload = structuredClone(catalogPayload);
		payload.sprocket.models.push({
			...payload.sprocket.models[0],
			id: 'model-large',
			label: 'Model XL'
		});
		payload.sprocket.defaultModelId = 'model-large';
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json(payload))
		);
		const catalog = await fetchGatewayModelCatalog('https://ai-gateway.spikonado.com');
		expect(resolveCatalogModel(catalog, 'unknown')).toBe('model-large');
		expect(resolveCatalogModel(catalog, 'model-small')).toBe('model-small');
	});

	it('orders models alphabetically by label', async () => {
		const payload = structuredClone(catalogPayload);
		payload.sprocket.models = ['Opus 5.5', 'GPT-6.1 Sol', 'GPT-6 Luna', 'deepseek V4.1'].map(
			(label) => ({ ...catalogPayload.sprocket.models[0], id: label, label })
		);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json(payload))
		);

		const catalog = await fetchGatewayModelCatalog('https://ai-gateway.spikonado.com');
		expect(catalog.models.map((model) => model.label)).toEqual([
			'deepseek V4.1',
			'GPT-6 Luna',
			'GPT-6.1 Sol',
			'Opus 5.5'
		]);
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

describe('service tiers', () => {
	const model = {
		...catalogPayload.sprocket.models[0],
		provider: 'openai',
		autoHandoffTokenLimit: 80_000,
		supportsFastMode: true
	};

	it('keeps provider order when deciding whether OpenAI BYOK is active', () => {
		expect(
			isDirectOpenAIByok(
				model,
				[
					{ provider: 'claude', enabled: true },
					{ provider: 'openai', enabled: true },
					{ provider: 'spikonado', enabled: true }
				],
				true
			)
		).toBe(true);

		for (const provider of ['spikonado', 'chatgpt', 'openrouter', 'vercel'] as const) {
			expect(
				isDirectOpenAIByok(
					model,
					[
						{ provider, enabled: true },
						{ provider: 'openai', enabled: true }
					],
					true
				)
			).toBe(false);
		}

		expect(isDirectOpenAIByok(model, [{ provider: 'openai', enabled: true }], false)).toBe(false);
	});

	it('offers Ultrafast only on the direct BYOK route and resets unavailable selections', () => {
		expect(availableServiceTiers(model, true)).toEqual(['standard', 'fast', 'ultrafast']);
		expect(availableServiceTiers(model, false)).toEqual(['standard', 'fast']);
		expect(normalizeServiceTier('ultrafast', model, false)).toBe('standard');
		expect(normalizeServiceTier('ultrafast', { ...model, byokServiceTiers: [] }, true)).toBe(
			'standard'
		);
		expect(normalizeServiceTier('fast', model, false)).toBe('fast');
	});
});
