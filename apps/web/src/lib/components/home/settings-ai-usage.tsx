import { useMemo, useState } from 'react';
import { useConvexAuth, useQuery_experimental } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { ModelCatalog } from '@convex/lib/uiModelCatalog';
import type { TokenUsageTotals } from '@convex/lib/validators';
import {
	API_COST_NOTE,
	billableTokens,
	breakdownOf,
	bucketLabel,
	bucketStartFor,
	cacheHitRate,
	costOf,
	formatCalls,
	formatCost,
	formatRate,
	formatTokens,
	modelUsageKey,
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

type Bucket = { start: number; rows: TokenUsageTotals[] };

export default function SettingsAiUsage({
	modelCatalog
}: {
	modelCatalog: ModelCatalog | undefined;
}) {
	const [rangeId, setRangeId] = useState<UsageRange['id']>('30d');
	const [metric, setMetric] = useState<Metric>('tokens');
	const [hiddenModels, setHiddenModels] = useState<ReadonlySet<string>>(new Set());
	const convexAuth = useConvexAuth();
	const now = useUsageTime();
	const range = usageRanges.find((candidate) => candidate.id === rangeId) ?? usageRanges[2];
	const usageWindow = rangeQuery(range, now);

	const usage = useQuery_experimental({
		query: api.aiUsage.getMyUsageBuckets,
		args: convexAuth.isAuthenticated && !convexAuth.isLoading ? usageWindow : 'skip'
	});

	const rows = useMemo(() => (usage.status === 'success' ? usage.data : []), [usage]);
	const models = useMemo(() => usageByModel(rows, modelCatalog), [rows, modelCatalog]);
	const visibleRows = rows.filter((row) => !hiddenModels.has(modelUsageKey(row)));
	const visibleModels = models.filter((model) => !hiddenModels.has(model.key));
	const breakdown = breakdownOf(visibleRows);
	const cost = costOf(visibleRows, modelCatalog);

	const buckets = rangeBucketStarts(range, now).map((start): Bucket => ({
		start,
		rows: visibleRows.filter((row) => bucketStartFor(range.unit, row.bucketStart) === start)
	}));

	function toggleModel(key: string) {
		setHiddenModels((hidden) => {
			const next = new Set(hidden);

			if (!next.delete(key)) next.add(key);

			return next;
		});
	}

	return (
		<section className="flex h-full min-h-0 flex-col overflow-hidden">
			<header className="flex h-12 shrink-0 items-center px-6">
				<h1 className="text-foreground text-[1rem] font-medium tracking-[-0.03em]">AI Usage</h1>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
				<div className="max-w-4xl space-y-8">
					<div className="flex flex-wrap justify-between gap-3">
						<UsageSegmented
							label="Range"
							value={range.id}
							onChange={setRangeId}
							options={usageRanges}
						/>
						<UsageSegmented
							label="Chart metric"
							value={metric}
							onChange={setMetric}
							options={[
								{ id: 'tokens', label: 'Tokens' },
								{ id: 'cost', label: 'API cost' }
							]}
						/>
					</div>

					{usage.status === 'error' ? (
						<p className="text-muted-foreground text-sm">
							Couldn’t load your AI usage right now. Try again in a moment.
						</p>
					) : (
						<>
							<div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
								<UsageStat
									label="Tokens"
									value={formatTokens(billableTokens(breakdown))}
									detail={formatCalls(breakdown.calls)}
								/>
								<UsageStat
									label="Cache hits"
									value={formatRate(cacheHitRate(breakdown))}
									detail="of input"
								/>
								<UsageStat
									label="Output"
									value={formatTokens(breakdown.output)}
									detail={`${formatTokens(breakdown.reasoning)} reasoning`}
								/>
								<UsageStat
									label="API cost"
									value={formatCost(cost)}
									detail={cost.partial ? 'excludes unpriced models' : undefined}
								/>
							</div>

							<div>
								<UsageChart
									buckets={buckets}
									unit={range.unit}
									metric={metric}
									models={models}
									modelCatalog={modelCatalog}
								/>
								<div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
									{models.map((model, index) => (
										<button
											key={model.key}
											type="button"
											aria-pressed={!hiddenModels.has(model.key)}
											onClick={() => toggleModel(model.key)}
											className={`flex cursor-pointer items-center gap-1.5 text-[12.5px] transition ${hiddenModels.has(model.key) ? 'opacity-45' : ''}`}
										>
											<span
												className="size-2.5 rounded-[2px]"
												style={{ background: modelColors[index % modelColors.length] }}
											></span>
											<span className="text-foreground">{model.label}</span>
											<span className="text-muted-foreground">· {model.providerLabel}</span>
										</button>
									))}
								</div>
							</div>

							<div>
								<UsageLabel>Token types</UsageLabel>
								<div className="mt-3 max-w-xl">
									<TokenTypeBreakdown breakdown={breakdown} />
								</div>
							</div>

							<div>
								<UsageLabel>By model</UsageLabel>
								<ModelTable models={visibleModels} />
								<p className="text-muted-foreground mt-3 text-[11.5px]">
									API cost: {API_COST_NOTE} Uses today’s prices. “—” means the model has no
									published price.
								</p>
							</div>
						</>
					)}
				</div>
			</div>
		</section>
	);
}

const CHART_WIDTH = 760;

const AXIS_WIDTH = 52;

const PLOT_WIDTH = CHART_WIDTH - AXIS_WIDTH;

const CHART_HEIGHT = 200;

function UsageChart({
	buckets,
	unit,
	metric,
	models,
	modelCatalog
}: {
	buckets: Bucket[];
	unit: UsageRange['unit'];
	metric: Metric;
	models: ModelUsage[];
	modelCatalog: ModelCatalog | undefined;
}) {
	const [hovered, setHovered] = useState<number | null>(null);

	const stacks = buckets.map((bucket) =>
		models.map((model) => {
			const rows = bucket.rows.filter((row) => modelUsageKey(row) === model.key);

			return metric === 'cost'
				? (costOf(rows, modelCatalog).usd ?? 0)
				: billableTokens(breakdownOf(rows));
		})
	);

	const peak = Math.max(0, ...stacks.map((stack) => stack.reduce((sum, value) => sum + value, 0)));
	const max = peak || 1;

	const format = (value: number) =>
		metric === 'cost' ? formatCost({ usd: value, partial: false }) : formatTokens(value);

	const gap = buckets.length > 20 ? 3 : 6;
	const barWidth = (PLOT_WIDTH - gap * (buckets.length - 1)) / buckets.length;
	const labelEvery = Math.ceil(buckets.length / 8);
	const hoveredBucket = hovered === null ? null : buckets[hovered];

	return (
		<div className="relative">
			<svg
				viewBox={`0 -6 ${CHART_WIDTH} ${CHART_HEIGHT + 28}`}
				className="block w-full"
				role="img"
				aria-label={`${metric === 'cost' ? 'API cost' : 'Tokens'} by ${unit}, UTC`}
				onMouseLeave={() => setHovered(null)}
			>
				{[0.5, 1].map((fraction) => (
					<g key={fraction}>
						<line
							x1="0"
							x2={PLOT_WIDTH}
							y1={CHART_HEIGHT * (1 - fraction)}
							y2={CHART_HEIGHT * (1 - fraction)}
							stroke="var(--hairline)"
						/>
						{peak > 0 ? (
							<text
								x={CHART_WIDTH}
								y={CHART_HEIGHT * (1 - fraction) + 4}
								textAnchor="end"
								className="fill-muted-foreground font-mono text-[10px]"
							>
								{format(peak * fraction)}
							</text>
						) : null}
					</g>
				))}
				<line x1="0" x2={PLOT_WIDTH} y1={CHART_HEIGHT} y2={CHART_HEIGHT} stroke="var(--hairline)" />
				{stacks.map((stack, bucketIndex) => {
					const x = bucketIndex * (barWidth + gap);
					let top = CHART_HEIGHT;

					return (
						<g key={buckets[bucketIndex].start} onMouseEnter={() => setHovered(bucketIndex)}>
							<rect
								x={x}
								y="0"
								width={barWidth}
								height={CHART_HEIGHT}
								fill={hovered === bucketIndex ? 'var(--hover-fill)' : 'transparent'}
							/>
							{stack.map((value, modelIndex) => {
								const height = (value / max) * CHART_HEIGHT;
								top -= height;

								return height > 0 ? (
									<rect
										key={models[modelIndex].key}
										x={x}
										y={top}
										width={barWidth}
										height={height}
										fill={modelColors[modelIndex % modelColors.length]}
									/>
								) : null;
							})}
							{bucketIndex % labelEvery === 0 ? (
								<AxisLabel
									x={x}
									barWidth={barWidth}
									edge={
										bucketIndex === 0 ? 'first' : bucketIndex === buckets.length - 1 ? 'last' : null
									}
								>
									{bucketLabel(unit, buckets[bucketIndex].start)}
								</AxisLabel>
							) : null}
						</g>
					);
				})}
			</svg>
			{hovered !== null && hoveredBucket ? (
				<div
					className="bg-tooltip text-tooltip-foreground pointer-events-none absolute top-2 min-w-44 rounded-md px-2.5 py-2 text-[12px] shadow-lg"
					style={{ left: `${Math.min(68, (hovered / buckets.length) * 100)}%` }}
				>
					<p className="mb-1 opacity-75">{bucketLabel(unit, hoveredBucket.start)} UTC</p>
					{models.map((model, modelIndex) =>
						stacks[hovered][modelIndex] > 0 ? (
							<p key={model.key} className="flex items-center gap-2">
								<span
									className="size-2 rounded-[2px]"
									style={{ background: modelColors[modelIndex % modelColors.length] }}
								></span>
								<span className="flex-1">{model.label}</span>
								<span className="tabular-nums">{format(stacks[hovered][modelIndex])}</span>
							</p>
						) : null
					)}
				</div>
			) : null}
			<p className="text-muted-foreground mt-1 text-[11.5px]">
				{unit === 'week' ? 'Weeks start on Monday. ' : ''}All times are UTC.
			</p>
		</div>
	);
}

function AxisLabel({
	x,
	barWidth,
	edge,
	children
}: {
	x: number;
	barWidth: number;
	edge: 'first' | 'last' | null;
	children: string;
}) {
	const anchor = edge === 'first' ? 'start' : edge === 'last' ? 'end' : 'middle';
	const anchorX = edge === 'first' ? x : edge === 'last' ? x + barWidth : x + barWidth / 2;

	return (
		<text
			x={anchorX}
			y={CHART_HEIGHT + 16}
			textAnchor={anchor}
			className="fill-muted-foreground font-mono text-[10px]"
		>
			{children}
		</text>
	);
}

const modelHeaderCell =
	'text-muted-foreground px-2.5 py-2 text-left text-[11.5px] font-normal whitespace-nowrap';

const headerCell =
	'text-muted-foreground px-2.5 py-2 text-right text-[11.5px] font-normal whitespace-nowrap';

const modelBodyCell = 'px-2.5 py-2 text-left whitespace-nowrap';

const bodyCell = 'px-2.5 py-2 text-right tabular-nums whitespace-nowrap';

function ModelTable({ models }: { models: ModelUsage[] }) {
	if (models.length === 0) {
		return <p className="text-muted-foreground mt-3 text-sm">No AI usage in this range.</p>;
	}

	return (
		<div className="mt-2 overflow-x-auto">
			<table className="w-full border-collapse text-[13px]">
				<thead>
					<tr className="border-b border-[var(--hairline)]">
						<th className={modelHeaderCell}>Model</th>
						<th className={headerCell}>Calls</th>
						<th className={headerCell}>Uncached input</th>
						<th className={headerCell}>Cache read</th>
						<th className={headerCell}>Cache write</th>
						<th className={headerCell}>Output</th>
						<th className={headerCell}>Cache hits</th>
						<th className={headerCell} title={API_COST_NOTE}>
							API cost
						</th>
					</tr>
				</thead>
				<tbody>
					{models.map((model) => (
						<tr key={model.key} className="border-b border-[var(--hairline)]">
							<td className={modelBodyCell}>
								{model.label} <span className="text-muted-foreground">· {model.providerLabel}</span>
							</td>
							<td className={bodyCell}>{model.breakdown.calls.toLocaleString()}</td>
							<td className={bodyCell}>{formatTokens(model.breakdown.uncachedInput)}</td>
							<td className={bodyCell}>{formatTokens(model.breakdown.cacheRead)}</td>
							<td className={bodyCell}>{formatTokens(model.breakdown.cacheWrite)}</td>
							<td className={bodyCell}>{formatTokens(model.breakdown.output)}</td>
							<td className={bodyCell}>{formatRate(cacheHitRate(model.breakdown))}</td>
							<td className={bodyCell}>{formatCost(model.cost)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
