<script lang="ts">
	import { useAuth, useQuery } from 'convex-svelte';
	import { api } from '$convex/_generated/api';
	import { usageMeters, usagePeriods } from '$convex/lib/usageMeters';
	import { tierLabels } from '$convex/lib/tiers';

	const convexAuth = useAuth();
	const usageQuery = useQuery(api.usage.getMyUsage, () =>
		convexAuth.isAuthenticated && !convexAuth.isLoading ? {} : 'skip'
	);

	let now = $state(Date.now());

	$effect(() => {
		const interval = setInterval(() => {
			now = Date.now();
		}, 60_000);
		return () => {
			clearInterval(interval);
		};
	});

	const compactAmount = new Intl.NumberFormat('en-US', {
		notation: 'compact',
		maximumFractionDigits: 1
	});

	const periodLabels = { weekly: 'Weekly', monthly: 'Monthly' } as const;

	function formatResetsIn(resetsAt: number) {
		const remainingMs = Math.max(0, resetsAt - now);
		const hours = Math.ceil(remainingMs / 3_600_000);
		if (hours >= 24) {
			const days = Math.floor(hours / 24);
			const restHours = hours % 24;
			return restHours > 0 ? `${days}d ${restHours}h` : `${days}d`;
		}
		if (remainingMs >= 3_600_000) {
			return `${hours}h`;
		}
		return `${Math.max(1, Math.ceil(remainingMs / 60_000))}m`;
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
</script>

<section class="flex h-full min-h-0 flex-col overflow-hidden">
	<header class="flex h-12 shrink-0 items-center px-6">
		<h1 class="text-foreground text-[1rem] font-medium tracking-[-0.03em]">Usage</h1>
	</header>

	<div class="min-h-0 flex-1 overflow-y-auto px-6 py-8">
		<div class="max-w-xl space-y-10">
			{#if usageQuery.error}
				<p class="text-muted-foreground text-sm leading-6">
					Couldn’t load your usage right now. Try again in a moment.
				</p>
			{:else if usageQuery.isLoading || usageQuery.data === undefined}
				<div class="animate-pulse space-y-10" aria-hidden="true">
					<div class="h-4 w-24 rounded bg-[var(--hover-fill)]"></div>
					{#each usageMeters as meter (meter.id)}
						<div class="space-y-5">
							<div class="h-3 w-28 rounded bg-[var(--hover-fill)]"></div>
							{#each usagePeriods as period (period)}
								<div class="space-y-2">
									<div class="h-3.5 w-full rounded bg-[var(--hover-fill)]"></div>
									<div class="h-1.5 w-full rounded-full bg-[var(--hover-fill)]"></div>
								</div>
							{/each}
						</div>
					{/each}
				</div>
			{:else}
				<div>
					<p class="text-muted-foreground text-[11px] tracking-[0.18em] uppercase">
						Subscription Tier
					</p>
					<p class="text-foreground mt-3 text-[15px]">
						{tierLabels[usageQuery.data.tier]}
					</p>
				</div>

				{#each usageQuery.data.meters as meter (meter.id)}
					<div>
						<p class="text-muted-foreground text-[11px] tracking-[0.18em] uppercase">
							{meter.label}
						</p>
						{#if meter.description}
							<p class="text-muted-foreground mt-1 text-[12px]">{meter.description}</p>
						{/if}
						<div class="mt-4 space-y-6">
							{#each meter.windows as meterWindow (meterWindow.period)}
								{@const hasLimit = meterWindow.limit > 0}
								{@const percent = hasLimit
									? Math.round((meterWindow.used / meterWindow.limit) * 100)
									: 0}
								{@const atLimit = hasLimit && meterWindow.used >= meterWindow.limit}
								{@const nearLimit = hasLimit && meterWindow.used >= meterWindow.limit * 0.9}
								<div>
									<div class="flex items-baseline justify-between gap-3">
										<p class="text-muted-foreground text-[13px]">
											{periodLabels[meterWindow.period]}
										</p>
										{#if hasLimit}
											<p
												class={`text-[12px] ${atLimit ? 'text-destructive' : nearLimit ? 'text-amber-800 dark:text-amber-300' : 'text-muted-foreground'}`}
											>
												{percent}% used
											</p>
										{/if}
									</div>
									<p class="text-muted-foreground mt-0.5 text-[12px]">
										{compactAmount.format(hasLimit ? meterWindow.used : 0)} / {compactAmount.format(
											hasLimit ? meterWindow.limit : 0
										)}
									</p>
									<div
										class="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--hover-fill)]"
										role="progressbar"
										aria-label={`${meter.label} — ${periodLabels[meterWindow.period]}`}
										aria-valuemin={0}
										aria-valuemax={hasLimit ? meterWindow.limit : 0}
										aria-valuenow={hasLimit ? Math.min(meterWindow.used, meterWindow.limit) : 0}
										aria-valuetext={hasLimit ? `${percent}% used` : '0 / 0'}
									>
										<div
											class={`h-full rounded-full transition-[width] duration-300 ${fillClass(atLimit, nearLimit)}`}
											style={`width: ${hasLimit ? Math.min(100, Math.max(0, percent)) : 0}%`}
										></div>
									</div>
									{#if meterWindow.resetsAt !== null}
										<p class="text-muted-foreground mt-1.5 text-[12px]">
											Resets in {formatResetsIn(meterWindow.resetsAt)}
										</p>
									{/if}
								</div>
							{/each}
						</div>
					</div>
				{/each}
			{/if}
		</div>
	</div>
</section>
