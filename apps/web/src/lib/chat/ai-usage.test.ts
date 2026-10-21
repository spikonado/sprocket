import { describe, expect, it } from 'vitest';
import type { ModelCatalog } from '@convex/lib/uiModelCatalog';
import { apiCost, axisTicks, rangeQuery, usageRanges } from '$lib/chat/ai-usage';

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
				cacheWrite: { '30m': 2.5, '12h': 5 },
				output: 10,
				fastMultiplier: 2,
				longContext: { inputMultiplier: 2, outputMultiplier: 1.5 }
			}
		}
	]
};

describe('apiCost', () => {
	// Standard 0.8 + 0.05 + writes + 1, long context 4 + 1.5, all doubled for fast.
	it.each([
		['30m', 15.2],
		['12h', 15.7],
		['5m', null],
		[null, null]
	])(
		'prices %s cache writes at their own rate, with long-context and fast multipliers',
		(ttl, usd) => {
			const cost = apiCost(
				{
					provider: 'chatgpt',
					model: 'sol',
					serviceTier: 'fast',
					cacheWriteTtl: ttl,
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

			if (usd === null) expect(cost).toBeNull();
			else expect(cost).toBeCloseTo(usd);
		}
	);
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

describe('axisTicks', () => {
	it.each([
		[6_300, [0, 2_000, 4_000, 6_000, 8_000]],
		[0.62, [0, 0.2, 0.4, 0.6, 0.8]],
		[100, [0, 25, 50, 75, 100]],
		[0, []]
	])('covers %s with round steps', (peak, ticks) => {
		expect(axisTicks(peak).map((tick) => Number(tick.toPrecision(6)))).toEqual(ticks);
	});
});
