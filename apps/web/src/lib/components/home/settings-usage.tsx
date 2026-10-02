import { useConvexAuth, useQuery_experimental as useConvexQueryResult } from 'convex/react';
import { api } from '@convex/_generated/api';
import { usageMeters, usagePeriods } from '@convex/lib/usageMeters';
import { MODEL_USAGE_UNITS_PER_DOLLAR } from '@convex/lib/tiers';
import { formatRemainingDuration } from '$lib/format';
import { useUsageTime } from '$lib/usage-time';

const dollars = new Intl.NumberFormat('en-US', {
	style: 'currency',
	currency: 'USD',
	minimumFractionDigits: 2,
	maximumFractionDigits: 2
});

const periodLabels = { weekly: 'Weekly', monthly: 'Monthly' } as const;

function formatDollars(units: number) {
	return dollars.format(units / MODEL_USAGE_UNITS_PER_DOLLAR);
}

function fillClass(atLimit: boolean, nearLimit: boolean) {
	if (atLimit) {
		return 'bg-rose-400/90';
	}

	if (nearLimit) {
		return 'bg-amber-400/90';
	}

	return 'bg-foreground/25';
}

export default function SettingsUsage() {
	const convexAuth = useConvexAuth();
	const now = useUsageTime();

	const usageQuery = useConvexQueryResult({
		query: api.usage.getMyUsage,
		args: convexAuth.isAuthenticated && !convexAuth.isLoading ? { now } : 'skip'
	});

	const usage = usageQuery.status === 'success' ? usageQuery.data : null;
	const usageError = usageQuery.status === 'error';

	return (
		<section className="flex h-full min-h-0 flex-col overflow-hidden">
			<header className="flex h-12 shrink-0 items-center px-6">
				<h1 className="text-foreground text-[1rem] font-medium tracking-[-0.03em]">Usage</h1>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
				<div className="max-w-xl space-y-10">
					{usageError ? (
						<p className="text-muted-foreground text-sm leading-6">
							Couldn’t load your usage right now. Try again in a moment.
						</p>
					) : usage === null ? (
						<div className="animate-pulse space-y-10" aria-hidden="true">
							<div className="bg-hover-fill h-4 w-24 rounded"></div>
							{usageMeters.map((meter) => (
								<div key={meter.id} className="space-y-5">
									<div className="bg-hover-fill h-3 w-28 rounded"></div>
									{usagePeriods.map((period) => (
										<div key={period} className="space-y-2">
											<div className="bg-hover-fill h-3.5 w-full rounded"></div>
											<div className="bg-hover-fill h-1.5 w-full rounded-full"></div>
										</div>
									))}
								</div>
							))}
						</div>
					) : (
						<>
							<div>
								<p className="text-muted-foreground text-[11px] tracking-[0.18em] uppercase">
									Subscription Tier
								</p>
								<p className="text-foreground mt-3 text-[15px]">{usage.tierLabel}</p>
							</div>

							{usage.meters.map((meter) => (
								<div key={meter.id}>
									<p className="text-muted-foreground text-[11px] tracking-[0.18em] uppercase">
										{meter.label}
									</p>
									{meter.description && (
										<p className="text-muted-foreground mt-1 text-[12px]">{meter.description}</p>
									)}
									<div className="mt-4 space-y-6">
										{meter.windows.map((meterWindow) => {
											const hasLimit = meterWindow.limit > 0;

											const percent = hasLimit
												? Math.round((meterWindow.used / meterWindow.limit) * 100)
												: 0;

											const atLimit = hasLimit && meterWindow.used >= meterWindow.limit;
											const nearLimit = hasLimit && meterWindow.used >= meterWindow.limit * 0.9;

											return (
												<div key={meterWindow.period}>
													<div className="flex items-baseline justify-between gap-3">
														<p className="text-muted-foreground text-[13px]">
															{periodLabels[meterWindow.period]}
														</p>
														{hasLimit && (
															<p
																className={`text-[12px] ${atLimit ? 'text-destructive' : nearLimit ? 'text-amber-800 dark:text-amber-300' : 'text-muted-foreground'}`}
															>
																{percent}% used
															</p>
														)}
													</div>
													<p className="text-muted-foreground mt-0.5 text-[12px]">
														{formatDollars(hasLimit ? meterWindow.used : 0)} /{' '}
														{formatDollars(hasLimit ? meterWindow.limit : 0)}
													</p>
													<div
														className="bg-hover-fill mt-2 h-1.5 overflow-hidden rounded-full"
														role="progressbar"
														aria-label={`${meter.label} — ${periodLabels[meterWindow.period]}`}
														aria-valuemin={0}
														aria-valuemax={hasLimit ? meterWindow.limit : 0}
														aria-valuenow={
															hasLimit ? Math.min(meterWindow.used, meterWindow.limit) : 0
														}
														aria-valuetext={hasLimit ? `${percent}% used` : '0 / 0'}
													>
														<div
															className={`h-full rounded-full transition-[width] duration-300 ${fillClass(atLimit, nearLimit)}`}
															style={{
																width: `${hasLimit ? Math.min(100, Math.max(0, percent)) : 0}%`
															}}
														></div>
													</div>
													{meterWindow.resetsAt !== null && (
														<p className="text-muted-foreground mt-1.5 text-[12px]">
															Resets in {formatRemainingDuration(meterWindow.resetsAt - now)}
														</p>
													)}
												</div>
											);
										})}
									</div>
								</div>
							))}
						</>
					)}
				</div>
			</div>
		</section>
	);
}
