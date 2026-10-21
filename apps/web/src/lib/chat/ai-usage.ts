import type { DirectApiPricing, ModelCatalog } from '@convex/lib/uiModelCatalog';
import type { CompletionProvider, TokenCounts, TokenUsageTotals } from '@convex/lib/validators';
import { completionProviderLabels } from '$lib/chat/providers';

export type TokenBreakdown = {
	calls: number;
	uncachedInput: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	reasoning: number;
};

export const emptyBreakdown: TokenBreakdown = {
	calls: 0,
	uncachedInput: 0,
	cacheRead: 0,
	cacheWrite: 0,
	output: 0,
	reasoning: 0
};

function addTokenCounts(total: TokenBreakdown, counts: TokenCounts): TokenBreakdown {
	return {
		calls: total.calls,
		uncachedInput:
			total.uncachedInput + counts.inputTokens - counts.cacheReadTokens - counts.cacheWriteTokens,
		cacheRead: total.cacheRead + counts.cacheReadTokens,
		cacheWrite: total.cacheWrite + counts.cacheWriteTokens,
		output: total.output + counts.outputTokens,
		reasoning: total.reasoning + counts.reasoningTokens
	};
}

export function breakdownOf(rows: readonly TokenUsageTotals[]): TokenBreakdown {
	return rows.reduce(
		(total, row) => ({
			...addTokenCounts(addTokenCounts(total, row.standard), row.longContext),
			calls: total.calls + row.calls
		}),
		emptyBreakdown
	);
}

/** Cache reads are excluded, since the same context is re-read on every turn. */
export function newTokens(breakdown: TokenBreakdown): number {
	return breakdown.uncachedInput + breakdown.cacheWrite + breakdown.output;
}

export function cacheHitRate(breakdown: TokenBreakdown): number | null {
	const input = breakdown.uncachedInput + breakdown.cacheRead + breakdown.cacheWrite;

	return input === 0 ? null : breakdown.cacheRead / input;
}

export type TokenTypeAmounts = Omit<TokenBreakdown, 'calls'>;

function amountsBy(amount: (key: keyof TokenTypeAmounts) => number): TokenTypeAmounts {
	return {
		uncachedInput: amount('uncachedInput'),
		cacheRead: amount('cacheRead'),
		cacheWrite: amount('cacheWrite'),
		output: amount('output'),
		reasoning: amount('reasoning')
	};
}

function countsCost(
	counts: TokenCounts,
	pricing: DirectApiPricing,
	cacheWritePrice: number,
	inputMultiplier: number,
	outputMultiplier: number
): TokenTypeAmounts {
	const uncached = counts.inputTokens - counts.cacheReadTokens - counts.cacheWriteTokens;

	return {
		uncachedInput: uncached * pricing.input * inputMultiplier,
		cacheRead: counts.cacheReadTokens * pricing.cacheRead * inputMultiplier,
		cacheWrite: counts.cacheWriteTokens * cacheWritePrice * inputMultiplier,
		output: counts.outputTokens * pricing.output * outputMultiplier,
		reasoning: counts.reasoningTokens * pricing.output * outputMultiplier
	};
}

/** USD per token type at today's direct-API list prices, or null when the catalog can't price the model or the row's cache writes. */
export function apiCostByType(
	row: TokenUsageTotals,
	catalog: ModelCatalog | undefined
): TokenTypeAmounts | null {
	const pricing = catalog?.models.find((model) => model.id === row.model)?.directApiPricing;

	if (!pricing) return null;

	const cacheWritePrice =
		row.cacheWriteTtl === null ? undefined : pricing.cacheWrite[row.cacheWriteTtl];

	const writes = row.standard.cacheWriteTokens + row.longContext.cacheWriteTokens;

	if (cacheWritePrice === undefined && writes > 0) return null;

	const tier = row.serviceTier === 'fast' ? pricing.fastMultiplier : 1;
	const longContext = pricing.longContext ?? { inputMultiplier: 1, outputMultiplier: 1 };

	const standard = countsCost(row.standard, pricing, cacheWritePrice ?? 0, 1, 1);

	const long = countsCost(
		row.longContext,
		pricing,
		cacheWritePrice ?? 0,
		longContext.inputMultiplier,
		longContext.outputMultiplier
	);

	return amountsBy((key) => ((standard[key] + long[key]) * tier) / 1_000_000);
}

export function apiCost(row: TokenUsageTotals, catalog: ModelCatalog | undefined): number | null {
	const cost = apiCostByType(row, catalog);

	return cost && cost.uncachedInput + cost.cacheRead + cost.cacheWrite + cost.output;
}

/** Summed over the rows the catalog can price; `costOf` reports whether any were left out. */
export function costByTypeOf(
	rows: readonly TokenUsageTotals[],
	catalog: ModelCatalog | undefined
): TokenTypeAmounts {
	return rows.reduce(
		(total, row) => {
			const cost = apiCostByType(row, catalog);

			return cost ? amountsBy((key) => total[key] + cost[key]) : total;
		},
		amountsBy(() => 0)
	);
}

export type CostSummary = { usd: number | null; partial: boolean };

export function costOf(
	rows: readonly TokenUsageTotals[],
	catalog: ModelCatalog | undefined
): CostSummary {
	const costs = rows.map((row) => apiCost(row, catalog));
	const known = costs.filter((cost) => cost !== null);

	if (known.length === 0 && rows.length > 0) return { usd: null, partial: false };

	return { usd: known.reduce((sum, cost) => sum + cost, 0), partial: known.length < rows.length };
}

export type ModelUsage = {
	key: string;
	label: string;
	providerLabel: string;
	rows: TokenUsageTotals[];
	breakdown: TokenBreakdown;
	cost: CostSummary;
};

export function modelUsageKey(row: { provider: CompletionProvider; model: string }) {
	return `${row.provider}:${row.model}`;
}

/** Groups by provider and model, merging service tiers, largest first. */
export function usageByModel(
	rows: readonly TokenUsageTotals[],
	catalog: ModelCatalog | undefined
): ModelUsage[] {
	const groups = new Map<string, TokenUsageTotals[]>();

	for (const row of rows) {
		const key = modelUsageKey(row);
		groups.set(key, [...(groups.get(key) ?? []), row]);
	}

	return [...groups.entries()]
		.map(([key, group]) => {
			const [first] = group;

			return {
				key,
				label: catalog?.models.find((model) => model.id === first.model)?.label ?? first.model,
				providerLabel: completionProviderLabels[first.provider],
				rows: group,
				breakdown: breakdownOf(group),
				cost: costOf(group, catalog)
			};
		})
		.sort((a, b) => newTokens(b.breakdown) - newTokens(a.breakdown));
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export function formatTokens(tokens: number): string {
	return compact.format(tokens);
}

const dollars = new Intl.NumberFormat('en-US', {
	style: 'currency',
	currency: 'USD',
	minimumFractionDigits: 2,
	maximumFractionDigits: 2
});

export function formatCost(cost: CostSummary): string {
	if (cost.usd === null) return '—';

	const amount = cost.usd > 0 && cost.usd < 0.01 ? '<$0.01' : dollars.format(cost.usd);

	return cost.partial ? `${amount}+` : amount;
}

export function formatRate(rate: number | null): string {
	return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

export function formatCalls(calls: number): string {
	return `${calls.toLocaleString()} ${calls === 1 ? 'call' : 'calls'}`;
}

/** Round axis ticks from 0 to at least `peak`, so gridlines land on readable values. */
export function axisTicks(peak: number): number[] {
	if (!(peak > 0)) return [];

	const rough = peak / 4;
	const magnitude = 10 ** Math.floor(Math.log10(rough));
	const step = ([1, 2, 2.5, 5, 10].find((m) => m * magnitude >= rough) ?? 10) * magnitude;

	return Array.from({ length: Math.ceil(peak / step - 1e-9) + 1 }, (_, index) => index * step);
}

export const API_COST_NOTE = 'What this would cost calling the provider API directly.';

type BucketUnit = 'hour' | 'day' | 'week' | 'month';

export const usageRanges = [
	{ id: '24h', label: '24 hours', unit: 'hour', count: 24 },
	{ id: '7d', label: '7 days', unit: 'day', count: 7 },
	{ id: '30d', label: '30 days', unit: 'day', count: 30 },
	{ id: '12w', label: '12 weeks', unit: 'week', count: 12 },
	{ id: '12m', label: '12 months', unit: 'month', count: 12 }
] as const satisfies readonly { id: string; label: string; unit: BucketUnit; count: number }[];

export type UsageRange = (typeof usageRanges)[number];

const HOUR_MS = 60 * 60 * 1000;

const DAY_MS = 24 * HOUR_MS;

/** UTC; weeks start on Monday. */
export function bucketStartFor(unit: BucketUnit, time: number): number {
	if (unit === 'hour') return time - (time % HOUR_MS);

	const day = time - (time % DAY_MS);

	if (unit === 'day') return day;

	if (unit === 'week') return day - ((new Date(day).getUTCDay() + 6) % 7) * DAY_MS;

	const date = new Date(time);

	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function shiftBucket(unit: BucketUnit, start: number, count: number): number {
	if (unit === 'month') {
		const date = new Date(start);

		return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1);
	}

	return start + count * { hour: HOUR_MS, day: DAY_MS, week: 7 * DAY_MS }[unit];
}

/** The range's bucket starts, oldest first, ending with the bucket that contains `now`. */
export function rangeBucketStarts(range: UsageRange, now: number): number[] {
	const last = bucketStartFor(range.unit, now);

	return Array.from({ length: range.count }, (_, index) =>
		shiftBucket(range.unit, last, index - range.count + 1)
	);
}

/** Stored rows are hourly or daily; weeks and months are summed from days. */
export function rangeQuery(range: UsageRange, now: number) {
	const starts = rangeBucketStarts(range, now);

	return {
		granularity: range.unit === 'hour' ? ('hour' as const) : ('day' as const),
		from: starts[0],
		to: shiftBucket(range.unit, starts[starts.length - 1], 1)
	};
}

/** Hours are exact instants, so they show in local time. Days are stored as UTC days. */
const bucketLabelFormats: Record<BucketUnit, Intl.DateTimeFormat> = {
	hour: new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }),
	day: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
	week: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
	month: new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
};

export function bucketLabel(unit: BucketUnit, start: number): string {
	const label = bucketLabelFormats[unit].format(start);

	return unit === 'week' ? `Week of ${label}` : label;
}
