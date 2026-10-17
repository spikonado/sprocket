import { useConvexAuth, useQuery_experimental as useConvexQueryResult } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '@convex/_generated/api';
import { usageMeters } from '@convex/lib/usageMeters';
import { MODEL_USAGE_UNITS_PER_DOLLAR } from '@convex/lib/tiers';
import { formatRemainingDuration } from '$lib/format';
import { useUsageTime } from '$lib/usage-time';

type UsageMeter = FunctionReturnType<typeof api.usage.getMyUsage>['meters'][number];

const dollars = new Intl.NumberFormat('en-US', {
	style: 'currency',
	currency: 'USD',
	minimumFractionDigits: 2,
	maximumFractionDigits: 2
});

function formatDollars(units: number) {
	return dollars.format(units / MODEL_USAGE_UNITS_PER_DOLLAR);
}

function SectionLabel({ children }: { children: string }) {
	return (
		<p className="text-muted-foreground font-mono text-[11px] tracking-[0.18em] uppercase">
			{children}
		</p>
	);
}

const toneClasses = {
	normal: { text: 'text-muted-foreground', fill: 'bg-foreground/25' },
	warning: { text: 'text-amber-800 dark:text-amber-300', fill: 'bg-amber-400/90' },
	limit: { text: 'text-destructive', fill: 'bg-rose-400/90' }
} as const;

function MeterUsage({ meter, now }: { meter: UsageMeter; now: number }) {
	const hasLimit = meter.limit > 0;
	const used = hasLimit ? meter.used : 0;
	const percent = hasLimit ? Math.round((used / meter.limit) * 100) : 0;

	const tone =
		toneClasses[
			hasLimit && used >= meter.limit
				? 'limit'
				: hasLimit && used >= meter.limit * 0.9
					? 'warning'
					: 'normal'
		];

	return (
		<div>
			<SectionLabel>{meter.label}</SectionLabel>
			<div className="mt-3 flex items-baseline justify-between gap-3 text-[13px]">
				<p className="text-foreground">
					{formatDollars(used)}{' '}
					<span className="text-muted-foreground">of {formatDollars(meter.limit)}</span>
				</p>
				<p className={tone.text}>{percent}% used</p>
			</div>
			<div
				className="bg-hover-fill mt-2 h-1.5 overflow-hidden rounded-full"
				role="progressbar"
				aria-label={meter.label}
				aria-valuemin={0}
				aria-valuemax={meter.limit}
				aria-valuenow={Math.min(used, meter.limit)}
				aria-valuetext={`${percent}% used`}
			>
				<div
					className={`h-full rounded-full transition-[width] duration-300 ${tone.fill}`}
					style={{ width: `${Math.min(100, percent)}%` }}
				></div>
			</div>
			{meter.resetsAt !== null && (
				<p className="text-muted-foreground mt-1.5 text-[12px]">
					Resets in {formatRemainingDuration(meter.resetsAt - now)}
				</p>
			)}
		</div>
	);
}

function UsageSkeleton() {
	return (
		<div className="animate-pulse space-y-10" aria-hidden="true">
			<div className="bg-hover-fill h-4 w-24 rounded"></div>
			{usageMeters.map((meter) => (
				<div key={meter.id} className="space-y-4">
					<div className="bg-hover-fill h-3 w-28 rounded"></div>
					<div className="bg-hover-fill h-3.5 w-full rounded"></div>
					<div className="bg-hover-fill h-1.5 w-full rounded-full"></div>
				</div>
			))}
		</div>
	);
}

export default function SpikonadoUsage() {
	const convexAuth = useConvexAuth();
	const now = useUsageTime();

	const usageQuery = useConvexQueryResult({
		query: api.usage.getMyUsage,
		args: convexAuth.isAuthenticated && !convexAuth.isLoading ? { now } : 'skip'
	});

	if (usageQuery.status === 'error') {
		return (
			<div>
				<SectionLabel>Subscription Tier</SectionLabel>
				<p className="text-muted-foreground mt-3 text-sm">
					Couldn’t load your usage right now. Try again in a moment.
				</p>
			</div>
		);
	}

	if (usageQuery.status !== 'success') return <UsageSkeleton />;

	return (
		<>
			<div>
				<SectionLabel>Subscription Tier</SectionLabel>
				<p className="text-foreground mt-3 text-[15px]">{usageQuery.data.tierLabel}</p>
			</div>
			{usageQuery.data.meters.map((meter) => (
				<MeterUsage key={meter.id} meter={meter} now={now} />
			))}
		</>
	);
}
