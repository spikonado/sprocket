import { describe, expect, it } from 'vitest';
import type { ModelCatalog } from '@convex/lib/uiModelCatalog';
import { apiCost, rangeQuery, usageRanges } from '$lib/chat/ai-usage';

const catalog: ModelCatalog = {
	defaultModelId: 'sol',
	defaultReasoningEffort: 'medium',
	models: [
		{
			id: 'sol',
			label: 'Sol',
			provider: 'openai',
			supportsImages: true,
			contextWindowTokens: 272_000,
			autoHandoffTokenLimit: 252_000,
			reasoningEfforts: ['medium'],
			defaultReasoningEffort: 'medium',
			supportsFastMode: true,
			directApiPricing: {
				input: 2,
				cacheRead: 0.1,
				cacheWrite: 2.5,
				output: 10,
				fastMultiplier: 2,
				longContext: { inputMultiplier: 2, outputMultiplier: 1.5 }
			}
		}
	]
};

describe('apiCost', () => {
	it('prices each token type with long-context and fast multipliers', () => {
		const cost = apiCost(
			{
				provider: 'chatgpt',
				model: 'sol',
				serviceTier: 'fast',
				calls: 2,
				standard: {
					inputTokens: 1_000_000,
					cacheReadTokens: 500_000,
					cacheWriteTokens: 100_000,
					outputTokens: 100_000,
					reasoningTokens: 0
				},
				longContext: {
					inputTokens: 1_000_000,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					outputTokens: 100_000,
					reasoningTokens: 0
				}
			},
			catalog
		);

		// Standard 0.8 + 0.05 + 0.25 + 1, long context 4 + 1.5, all doubled for fast.
		expect(cost).toBeCloseTo(15.2);
	});
});

describe('rangeQuery', () => {
	const now = Date.parse('2026-10-21T10:30:00.000Z');

	it.each([
		['24h', 'hour', '2026-10-20T11:00:00.000Z', '2026-10-21T11:00:00.000Z'],
		['12w', 'day', '2026-08-03T00:00:00.000Z', '2026-10-26T00:00:00.000Z'],
		['12m', 'day', '2025-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z']
	])('%s reads %s rows covering whole UTC buckets', (id, granularity, from, to) => {
		const range = usageRanges.find((candidate) => candidate.id === id)!;

		expect(rangeQuery(range, now)).toEqual({
			granularity,
			from: Date.parse(from),
			to: Date.parse(to)
		});
	});
});
