import { emptyCounts } from '@convex/lib/tokenUsage';
import type { TokenUsageTotals } from '@convex/lib/validators';
import { modelCatalog } from './models';
import type { TranscriptFixture } from './types';

/** Plausible, deterministic token counts for a recorded run: one model call per tool plus the reply. */
export function runUsage(modelId: string, run: TranscriptFixture): TokenUsageTotals {
	const calls =
		1 +
		Object.values(run.work)
			.flat()
			.filter((row) => row.kind === 'tool').length;

	const replyChars = run.rows.reduce(
		(total, row) => total + (row.kind === 'text' ? row.text.length : 0),
		0
	);

	const inputTokens = calls * (16_000 + 1_200 * calls);
	const outputTokens = Math.round(replyChars / 4) + 260 * calls;
	const pricing = modelCatalog.models.find((model) => model.id === modelId)?.directApiPricing;

	return {
		provider: 'spikonado',
		model: modelId,
		serviceTier: 'standard',
		cacheWriteTtl: pricing ? (Object.keys(pricing.cacheWrite)[0] ?? null) : null,
		calls,
		standard: {
			inputTokens,
			cacheReadTokens: Math.round(inputTokens * 0.86),
			cacheWriteTokens: Math.round(inputTokens * 0.06),
			outputTokens,
			reasoningTokens: Math.round(outputTokens * 0.4)
		},
		longContext: emptyCounts
	};
}
