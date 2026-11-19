import type { CatalogModel, DirectApiPricing, ModelCatalog } from '@convex/lib/uiModelCatalog';

const LONG_CONTEXT = { inputMultiplier: 2, outputMultiplier: 1.5 };

function model(
	id: string,
	label: string,
	provider: string,
	reasoningEfforts: readonly string[],
	defaultReasoningEffort: string,
	directApiPricing: DirectApiPricing
): CatalogModel {
	return {
		id,
		label,
		provider,
		supportsImages: true,
		contextWindowTokens: 272_000,
		autoHandoffTokenLimit: 252_000,
		reasoningEfforts,
		defaultReasoningEffort,
		supportsFastMode: false,
		directApiPricing
	};
}

const OPENAI_EFFORTS = ['medium', 'high', 'xhigh'];
const ANTHROPIC_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

export const modelCatalog: ModelCatalog = {
	defaultModelId: 'opus-5.5',
	defaultReasoningEffort: 'medium',
	models: [
		model('gpt-6.2-sol', 'GPT-6.2 Sol', 'openai', OPENAI_EFFORTS, 'medium', {
			input: 2,
			cacheRead: 0.1,
			cacheWrite: { '30m': 2.5, '12h': 5 },
			output: 10,
			fastMultiplier: 2,
			longContext: LONG_CONTEXT
		}),
		model('gpt-6.1-terra', 'GPT-6.1 Terra', 'openai', OPENAI_EFFORTS, 'medium', {
			input: 1,
			cacheRead: 0.05,
			cacheWrite: { '30m': 1.25, '12h': 2.5 },
			output: 5,
			fastMultiplier: 2,
			longContext: LONG_CONTEXT
		}),
		model('opus-5.5', 'Opus 5.5', 'anthropic', ANTHROPIC_EFFORTS, 'medium', {
			input: 4,
			cacheRead: 0.2,
			cacheWrite: { '5m': 5, '1h': 8 },
			output: 20,
			fastMultiplier: 2,
			longContext: null
		}),
		model('sonnet-5.5', 'Sonnet 5.5', 'anthropic', ANTHROPIC_EFFORTS, 'high', {
			input: 2,
			cacheRead: 0.1,
			cacheWrite: { '5m': 2.5, '1h': 4 },
			output: 10,
			fastMultiplier: 1,
			longContext: null
		}),
		model('haiku-5.5', 'Haiku 5.5', 'anthropic', ANTHROPIC_EFFORTS, 'medium', {
			input: 0.1,
			cacheRead: 0.01,
			cacheWrite: { '5m': 0.125, '1h': 0.2 },
			output: 0.5,
			fastMultiplier: 1,
			longContext: null
		}),
		model('kimi-k3.1-pro', 'Kimi K3.1 Pro', 'moonshotai', ['low', 'high', 'max'], 'high', {
			input: 2,
			cacheRead: 0.2,
			cacheWrite: { '5m': 2 },
			output: 10,
			fastMultiplier: 1,
			longContext: null
		})
	]
};
