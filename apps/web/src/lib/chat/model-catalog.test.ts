import { describe, expect, it, vi, afterEach } from 'vitest';
import {
	fetchGatewayModelCatalog,
	modelOptionsForProviders,
	resolveModelForProviders,
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
		expect(catalog).not.toHaveProperty('tierAllowsFastMode');
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

	it('offers only OpenAI models for a direct OpenAI provider without tier locks', async () => {
		const payload = structuredClone(catalogPayload);
		payload.sprocket.models = [
			{ ...payload.sprocket.models[0], id: 'openai-paid', provider: 'openai' },
			{ ...payload.sprocket.models[0], id: 'other-free', provider: 'other' }
		];
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json(payload))
		);
		const catalog = await fetchGatewayModelCatalog('https://ai-gateway.spikonado.com');

		expect(modelOptionsForProviders(catalog, ['openai'])).toEqual([
			expect.objectContaining({ id: 'openai-paid', provider: 'openai' })
		]);
		expect(resolveModelForProviders(catalog, ['openai'], 'other-free')).toBe('openai-paid');
	});

	it('offers ChatGPT models and settings only from the gateway catalog', async () => {
		const payload = structuredClone(catalogPayload);
		payload.sprocket.models = [
			{
				...payload.sprocket.models[0],
				id: 'gpt-6.1-sol',
				label: 'GPT-6.1 Sol',
				provider: 'openai'
			},
			{ ...payload.sprocket.models[0], id: 'gpt-6-luna', label: 'GPT-6 Luna', provider: 'openai' },
			{ ...payload.sprocket.models[0], id: 'other', provider: 'other' }
		];
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json(payload))
		);
		const catalog = await fetchGatewayModelCatalog('https://ai-gateway.spikonado.com');
		expect(modelOptionsForProviders(catalog, ['chatgpt'])).toEqual([
			{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', provider: 'openai' },
			{ id: 'gpt-6-luna', label: 'GPT-6 Luna', provider: 'openai' }
		]);
		expect(resolveModelForProviders(catalog, ['chatgpt'], 'unknown')).toBe('gpt-6.1-sol');
		expect(resolveModelForProviders(catalog, ['chatgpt'], 'other')).toBe('gpt-6.1-sol');
		expect(resolveModelForProviders(catalog, ['chatgpt'], 'gpt-6-luna')).toBe('gpt-6-luna');
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
