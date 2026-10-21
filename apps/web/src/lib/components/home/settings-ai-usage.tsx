import { useMemo, useState } from 'react';
import { useConvexAuth, useQuery_experimental } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '@convex/_generated/api';
import type { ModelCatalog } from '@convex/lib/uiModelCatalog';
import {
	API_COST_NOTE,
	axisTicks,
	breakdownOf,
	bucketLabel,
	bucketStartFor,
	cacheHitRate,
	costOf,
	formatCost,
	formatRate,
	formatTokens,
	modelUsageKey,
	newTokens,
	rangeBucketStarts,
	rangeQuery,
	usageByModel,
	usageRanges,
	type ModelUsage,
	type UsageRange
} from '$lib/chat/ai-usage';
import { useUsageTime } from '$lib/usage-time';
import {
	modelColors,
	TokenTypeBreakdown,
	UsageLabel,
	UsageSegmented,
	UsageStat
} from '$lib/components/home/ai-usage-parts';

type Metric = 'tokens' | 'cost';

type UsageRow = FunctionReturnType<typeof api.aiUsage.getMyUsageBuckets>[number];

type Bucket = { start: number; rows: UsageRow[] };

type Loaded = { rows: UsageRow[]; range: UsageRange; now: number };

export default function SettingsAiUsage({
	modelCatalog
}: {
	modelCatalog: ModelCatalog | undefined;
}) {
	const [rangeId, setRangeId] = useState<UsageRange['id']>('30d');
	const [metric, setMetric] = useState<Metric>('tokens');
	const [hiddenModels, setHiddenModels] = useState<ReadonlySet<string>>(new Set());
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	const convexAuth = useConvexAuth();
	const now = useUsageTime();
	const range = usageRanges.find((candidate) => candidate.id === rangeId) ?? usageRanges[2];

	const usage = useQuery_experimental({
		query: api.aiUsage.getMyUsageBuckets,
		args: convexAuth.isAuthenticated && !convexAuth.isLoading ? rangeQuery(range, now) : 'skip'
	});

	// Keeps the last result on screen while another range loads, instead of blanking the page.
	if (usage.status === 'success' && loaded?.rows !== usage.data) {
		setLoaded({ rows: usage.data, range, now });
	}

	return (
		<section className="flex h-full min-h-0 flex-col overflow-hidden">
			<header className="flex h-12 shrink-0 items-center px-6">
				<h1 className="text-foreground text-[1rem] font-medium tracking-[-0.03em]">AI Usage</h1>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
				<div className="max-w-4xl space-y-8">
					<div className="overflow-x-auto">
						<UsageSegmented
							label="Range"
							value={range.id}
							onChange={setRangeId}
							options={usageRanges}
						/>
					</div>

					{usage.status === 'error' ? (
						<p className="text-muted-foreground text-sm">
							Couldn’t load your AI usage. Check your connection, then reopen this page.
						</p>
					) : loaded === null ? (
						<UsageSkeleton />
					) : (
						<UsageReport
							loaded={loaded}
							stale={usage.status !== 'success'}
							metric={metric}
							onMetric={setMetric}
							hiddenModels={hiddenModels}
							onHiddenModels={setHiddenModels}
							modelCatalog={modelCatalog}
						/>
					)}
				</div>
			</div>
		</section>
	);
}

function UsageReport({
	loaded: { rows, range, now },
	stale,
	metric,
	onMetric,
	hiddenModels,
	onHiddenModels,
	modelCatalog
}: {
	loaded: Loaded;
	stale: boolean;
	metric: Metric;
	onMetric: (metric: Metric) => void;
	hiddenModels: ReadonlySet<string>;
	onHiddenModels: (hidden: ReadonlySet<string>) => void;
	modelCatalog: ModelCatalog | undefined;
}) {
	const models = useMemo(() => usageByModel(rows, modelCatalog), [rows, modelCatalog]);
	const visibleRows = rows.filter((row) => !hiddenModels.has(modelUsageKey(row)));
	const visibleModels = models.filter((model) => !hiddenModels.has(model.key));
	const breakdown = breakdownOf(visibleRows);
	const cost = costOf(visibleRows, modelCatalog);

	const colors = new Map(
		models.map((model, index) => [model.key, modelColors[index % modelColors.length]])
	);

	const buckets = rangeBucketStarts(range, now).map((start): Bucket => ({
		start,
		rows: visibleRows.filter((row) => bucketStartFor(range.unit, row.bucketStart) === start)
	}));

	function toggleModel(key: string) {
		const next = new Set(hiddenModels);

		if (!next.delete(key)) next.add(key);
		onHiddenModels(next);
	}

	if (rows.length === 0) {
		return (
			<div
				aria-busy={stale}
				className="rounded-xl border border-dashed border-[var(--hairline)] px-6 py-14 text-center"
			>
				<p className="text-foreground text-[14px]">
					No AI usage in the last {range.label.toLowerCase()}
				</p>
				<p className="text-muted-foreground mt-1 text-[12.5px]">
					Tokens and costs show up here after your agents call a model.
				</p>
			</div>
		);
	}

	return (
		<div aria-busy={stale} className={`space-y-9 transition-opacity ${stale ? 'opacity-55' : ''}`}>
			<div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-4">
				<UsageStat
					label="API cost"
					value={formatCost(cost)}
					detail={cost.partial ? 'Excludes unpriced models' : 'At direct API prices'}
				/>
				<UsageStat
					label="Tokens"
					value={formatTokens(newTokens(breakdown))}
					detail="Excludes cache reads"
				/>
				<UsageStat
					label="Cache hit rate"
					value={formatRate(cacheHitRate(breakdown))}
					detail={`${formatTokens(breakdown.cacheRead)} read from cache`}
				/>
				<UsageStat
					label="Model calls"
					value={breakdown.calls.toLocaleString()}
					detail={`${visibleModels.length} ${visibleModels.length === 1 ? 'model' : 'models'}`}
				/>
			</div>

			<div>
				<div className="mb-4 flex flex-wrap items-center justify-between gap-3">
					<UsageLabel>
						{metric === 'cost' ? 'API cost' : 'Tokens'} per {range.unit}
					</UsageLabel>
					<UsageSegmented
						label="Chart metric"
						value={metric}
						onChange={onMetric}
						options={[
							{ id: 'tokens', label: 'Tokens' },
							{ id: 'cost', label: 'API cost' }
						]}
					/>
				</div>
				<UsageChart
					key={range.id}
					buckets={buckets}
					unit={range.unit}
					metric={metric}
					models={visibleModels}
					colors={colors}
					modelCatalog={modelCatalog}
				/>
			</div>

			<div>
				<UsageLabel>Models</UsageLabel>
				<ModelTable
					models={models}
					colors={colors}
					hiddenModels={hiddenModels}
					onToggle={toggleModel}
				/>
			</div>

			<div>
				<UsageLabel>Token types</UsageLabel>
				<div className="mt-3 max-w-xl">
					<TokenTypeBreakdown breakdown={breakdown} />
				</div>
			</div>

			<p className="text-muted-foreground text-[11.5px]">
				API cost: {API_COST_NOTE} Uses today’s prices. “—” means the model has no published price.
			</p>
		</div>
	);
}

function UsageSkeleton() {
	return (
		<div className="animate-pulse space-y-9" aria-label="Loading AI usage">
			<div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
				{[0, 1, 2, 3].map((index) => (
					<div key={index} className="space-y-2">
						<div className="bg-hover-fill h-3 w-16 rounded"></div>
						<div className="bg-hover-fill h-6 w-24 rounded"></div>
					</div>
				))}
			</div>
			<div className="bg-hover-fill h-56 rounded-xl"></div>
		</div>
	);
}

const currentBucketLabels: Record<UsageRange['unit'], string> = {
	hour: 'Now',
	day: 'Today',
	week: 'This week',
	month: 'This month'
};

function UsageChart({
	buckets,
	unit,
	metric,
	models,
	colors,
	modelCatalog
}: {
	buckets: Bucket[];
	unit: UsageRange['unit'];
	metric: Metric;
	models: ModelUsage[];
	colors: ReadonlyMap<string, string>;
	modelCatalog: ModelCatalog | undefined;
}) {
	const [hovered, setHovered] = useState<number | null>(null);

	// Null marks a model with usage in the bucket but no price, so it isn't shown as idle.
	const stacks = buckets.map((bucket) =>
		models.map((model) => {
			const rows = bucket.rows.filter((row) => modelUsageKey(row) === model.key);

			if (rows.length === 0) return 0;

			return metric === 'cost' ? costOf(rows, modelCatalog).usd : newTokens(breakdownOf(rows));
		})
	);

	const totals = stacks.map((stack) => stack.reduce<number>((sum, value) => sum + (value ?? 0), 0));
	const ticks = axisTicks(Math.max(0, ...totals));
	const max = ticks.at(-1) ?? 1;

	const format = (value: number | null) =>
		metric === 'cost' || value === null
			? formatCost({ usd: value, partial: false })
			: formatTokens(value);

	const entries = stacks.map((stack) =>
		models.flatMap((model, modelIndex) => {
			const value = stack[modelIndex];

			return value === null || value > 0
				? [
						{
							key: model.key,
							label: model.label,
							color: colors.get(model.key),
							value: format(value)
						}
					]
				: [];
		})
	);

	const labelEvery = Math.ceil(buckets.length / 6);
	const gap = buckets.length > 20 ? 'gap-[3px]' : 'gap-2';
	const last = buckets.length - 1;

	return (
		<div>
			<div className="flex">
				<div
					role="list"
					aria-label={`${metric === 'cost' ? 'API cost' : 'Tokens'} per ${unit}`}
					className={`relative flex h-52 flex-1 ${gap}`}
					onMouseLeave={() => setHovered(null)}
				>
					{ticks.map((tick) => (
						<div
							key={tick}
							aria-hidden="true"
							className="pointer-events-none absolute inset-x-0 border-t border-[var(--hairline)]"
							style={{ bottom: `${(tick / max) * 100}%` }}
						></div>
					))}
					{buckets.map((bucket, index) => {
						const stack = stacks[index];
						const values = entries[index].map((entry) => `${entry.label} ${entry.value}`);

						return (
							<div
								key={bucket.start}
								role="listitem"
								tabIndex={0}
								aria-label={`${bucketLabel(unit, bucket.start)}: ${values.join(', ') || 'no usage'}`}
								className={`relative flex h-full min-w-0 flex-1 flex-col justify-end rounded-[4px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${hovered === index ? 'bg-hover-fill' : ''}`}
								onMouseEnter={() => setHovered(index)}
								onFocus={() => setHovered(index)}
								onBlur={() => setHovered(null)}
							>
								<div
									className="flex flex-col-reverse overflow-hidden rounded-t-[3px]"
									style={{ height: `${(totals[index] / max) * 100}%` }}
								>
									{stack.map((value, modelIndex) =>
										value ? (
											<div
												key={models[modelIndex].key}
												style={{
													height: `${(value / totals[index]) * 100}%`,
													background: colors.get(models[modelIndex].key)
												}}
											></div>
										) : null
									)}
								</div>
							</div>
						);
					})}
					{hovered !== null ? (
						<ChartTooltip
							index={hovered}
							count={buckets.length}
							title={bucketLabel(unit, buckets[hovered].start)}
							rows={entries[hovered]}
							total={
								metric === 'cost'
									? formatCost(costOf(buckets[hovered].rows, modelCatalog))
									: format(totals[hovered])
							}
						/>
					) : null}
				</div>
				<div aria-hidden="true" className="relative h-52 w-14 shrink-0">
					{ticks.map((tick) => (
						<span
							key={tick}
							className="text-muted-foreground absolute right-0 translate-y-1/2 text-[11px] tabular-nums"
							style={{ bottom: `${(tick / max) * 100}%` }}
						>
							{format(tick)}
						</span>
					))}
				</div>
			</div>
			<div aria-hidden="true" className={`mt-2 mr-14 flex ${gap}`}>
				{buckets.map((bucket, index) => (
					<div key={bucket.start} className="relative h-4 min-w-0 flex-1">
						{index === last || (index % labelEvery === 0 && last - index >= labelEvery / 2) ? (
							<span
								className={`text-muted-foreground absolute text-[11px] whitespace-nowrap ${
									index === 0 ? 'left-0' : index === last ? 'right-0' : 'left-1/2 -translate-x-1/2'
								} ${index !== last && (index / labelEvery) % 2 === 1 ? 'max-sm:hidden' : ''}`}
							>
								{index === last
									? currentBucketLabels[unit]
									: bucketLabel(unit === 'week' ? 'day' : unit, bucket.start)}
							</span>
						) : null}
					</div>
				))}
			</div>
			<p className="text-muted-foreground mt-3 text-[11.5px]">
				{unit === 'hour'
					? 'Hours are in your local time.'
					: `Days start at 00:00 UTC${unit === 'week' ? ', and weeks start on Monday' : ''}.`}
			</p>
		</div>
	);
}

function ChartTooltip({
	index,
	count,
	title,
	rows,
	total
}: {
	index: number;
	count: number;
	title: string;
	rows: { key: string; label: string; color: string | undefined; value: string }[];
	total: string;
}) {
	const center = ((index + 0.5) / count) * 100;

	return (
		<div
			className="bg-tooltip text-tooltip-foreground pointer-events-none absolute top-0 z-10 w-max max-w-64 min-w-40 rounded-lg px-3 py-2 text-[12px] shadow-lg"
			style={
				center < 50
					? { left: `calc(${center}% + 14px)` }
					: { right: `calc(${100 - center}% + 14px)` }
			}
		>
			<p className="mb-1.5 opacity-70">{title}</p>
			{rows.length === 0 ? <p className="opacity-70">No usage</p> : null}
			{rows.map((row) => (
				<p key={row.key} className="flex items-center gap-2">
					<span className="size-2 shrink-0 rounded-[2px]" style={{ background: row.color }}></span>
					<span className="min-w-0 flex-1 truncate">{row.label}</span>
					<span className="tabular-nums">{row.value}</span>
				</p>
			))}
			{rows.length > 1 ? (
				<p className="mt-1.5 flex justify-between gap-2 border-t border-current/15 pt-1.5">
					<span>Total</span>
					<span className="tabular-nums">{total}</span>
				</p>
			) : null}
		</div>
	);
}

const headerBase = 'text-muted-foreground px-2.5 py-2 text-[11.5px] font-normal whitespace-nowrap';

const headerCell = `${headerBase} text-right`;

const bodyCell = 'px-2.5 py-2 text-right tabular-nums whitespace-nowrap';

function ModelTable({
	models,
	colors,
	hiddenModels,
	onToggle
}: {
	models: ModelUsage[];
	colors: ReadonlyMap<string, string>;
	hiddenModels: ReadonlySet<string>;
	onToggle: (key: string) => void;
}) {
	const peak = Math.max(1, ...models.map((model) => newTokens(model.breakdown)));

	return (
		<div className="mt-2 overflow-x-auto">
			<table className="w-full border-collapse text-[13px]">
				<thead>
					<tr className="border-b border-[var(--hairline)]">
						<th className={`${headerBase} text-left`}>Model</th>
						<th className={`${headerBase} w-[30%] text-left`}>Tokens</th>
						<th className={headerCell}>Calls</th>
						<th className={headerCell}>Cache hits</th>
						<th className={headerCell} title={API_COST_NOTE}>
							API cost
						</th>
					</tr>
				</thead>
				<tbody>
					{models.map((model) => {
						const hidden = hiddenModels.has(model.key);
						const tokens = newTokens(model.breakdown);
						const color = colors.get(model.key);

						return (
							<tr
								key={model.key}
								className={`border-b border-[var(--hairline)] transition-opacity ${hidden ? 'opacity-45' : ''}`}
							>
								<td className="py-1 pr-2.5 text-left whitespace-nowrap">
									<button
										type="button"
										aria-pressed={!hidden}
										title={hidden ? 'Include in totals and chart' : 'Leave out of totals and chart'}
										onClick={() => onToggle(model.key)}
										className="hover:bg-hover-fill flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition"
									>
										<span
											className="size-2.5 shrink-0 rounded-[3px] border-[1.5px]"
											style={{ background: hidden ? 'transparent' : color, borderColor: color }}
										></span>
										<span className="text-foreground">{model.label}</span>
										<span className="text-muted-foreground">{model.providerLabel}</span>
									</button>
								</td>
								<td className="px-2.5 py-2">
									<div className="flex items-center gap-2.5">
										<span className="w-12 shrink-0 tabular-nums">{formatTokens(tokens)}</span>
										<div className="bg-hover-fill h-1.5 min-w-12 flex-1 overflow-hidden rounded-full">
											<div
												className="h-full rounded-full"
												style={{ width: `${(tokens / peak) * 100}%`, background: color }}
											></div>
										</div>
									</div>
								</td>
								<td className={bodyCell}>{model.breakdown.calls.toLocaleString()}</td>
								<td className={bodyCell}>{formatRate(cacheHitRate(model.breakdown))}</td>
								<td className={bodyCell}>{formatCost(model.cost)}</td>
							</tr>
						);
					})}
				</tbody>
			</table>
			{models.length > 1 ? (
				<p className="text-muted-foreground mt-2 text-[11.5px]">
					Select a model to leave it out of the totals and chart.
				</p>
			) : null}
		</div>
	);
}
