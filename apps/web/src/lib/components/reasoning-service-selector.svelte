<script lang="ts">
	import { Check, ChevronDown, Lock, Zap } from '@lucide/svelte';
	import { defaultReasoningEffort, defaultServiceTier } from '$convex/lib/models';
	import {
		type CatalogModel,
		type ServiceTierSelectorOption,
		reasoningEffortLabel,
		serviceTierLabel
	} from '$lib/chat/model-catalog';
	import { createLockTooltip } from '$lib/components/ui/lock-tooltip.svelte';
	import { listenOpenMenuDismiss } from '$lib/components/ui/menu-dismiss.svelte';
	import Tooltip from '$lib/components/ui/tooltip.svelte';
	import { cn } from '$lib/utils';

	type Props = {
		model: CatalogModel;
		/** When set, shows every model service tier with paid ones locked (like the model picker). */
		serviceTierOptions?: readonly ServiceTierSelectorOption[];
		reasoningEffort?: string;
		serviceTier?: string;
		disabled?: boolean;
		className?: string;
	};

	let {
		model,
		serviceTierOptions,
		reasoningEffort = $bindable<string>(defaultReasoningEffort),
		serviceTier = $bindable<string>(defaultServiceTier),
		disabled = false,
		className = ''
	}: Props = $props();

	const tierOptions = $derived.by((): readonly ServiceTierSelectorOption[] => {
		if (serviceTierOptions) return serviceTierOptions;
		return model.serviceTiers.map((tier) => ({
			id: tier,
			label: serviceTierLabel(tier)
		}));
	});
	const unlockedServiceTiers = $derived(
		tierOptions.filter((option) => !option.locked).map((option) => option.id)
	);

	let isOpen = $state(false);
	let rootElement = $state<HTMLDivElement | null>(null);
	let triggerElement = $state<HTMLButtonElement | null>(null);
	const lockTooltipState = createLockTooltip();

	function selectReasoning(next: string) {
		reasoningEffort = next;
	}

	function selectServiceTier(next: string, event?: MouseEvent) {
		const option = tierOptions.find((entry) => entry.id === next);
		if (!option) return;
		if (option.locked) {
			if (event && option.lockTooltip)
				lockTooltipState.showLockTooltip(event, option.lockTooltip, true);
			return;
		}
		serviceTier = next;
	}

	$effect(() => {
		const supportedReasoning = model.reasoningEfforts;
		if (!supportedReasoning.includes(reasoningEffort)) {
			reasoningEffort = model.defaultReasoningEffort;
		}
		if (!unlockedServiceTiers.includes(serviceTier)) {
			serviceTier = unlockedServiceTiers[0] ?? defaultServiceTier;
		}
	});

	$effect(() => {
		if (!isOpen) {
			lockTooltipState.hideLockTooltip();
			return;
		}

		return listenOpenMenuDismiss({
			getRoot: () => rootElement,
			onOutside: () => {
				isOpen = false;
			},
			onEscape: () => {
				isOpen = false;
				triggerElement?.focus();
			}
		});
	});

	$effect(() => {
		if (disabled) isOpen = false;
	});
</script>

<div bind:this={rootElement} class={cn('relative', className)}>
	<button
		bind:this={triggerElement}
		type="button"
		class="focus-visible:ring-ring/60 text-muted-foreground hover:bg-hover-fill inline-flex h-9 shrink-0 items-center gap-1 rounded-lg px-2 text-[15px] transition outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50"
		aria-haspopup="dialog"
		aria-expanded={isOpen}
		aria-label="Select reasoning effort and service tier"
		{disabled}
		onclick={() => {
			isOpen = !isOpen;
		}}
	>
		<span>{reasoningEffortLabel(reasoningEffort)} · {serviceTierLabel(serviceTier)}</span>
		<ChevronDown
			class={cn(
				'text-muted-foreground size-3 shrink-0 transition-transform',
				isOpen && 'rotate-180'
			)}
		/>
	</button>

	{#if isOpen}
		<div
			class="bg-popover/96 absolute bottom-[calc(100%+0.75rem)] left-0 z-50 min-w-[15rem] rounded-[18px] border border-[var(--hairline)] p-2 shadow-[var(--composer-shadow)] backdrop-blur-xl"
			role="dialog"
			aria-label="Reasoning and service tier"
		>
			<p class="text-muted-foreground px-3 pt-1 pb-1.5 text-[11px] font-medium">Reasoning</p>
			<div class="space-y-0.5">
				{#each model.reasoningEfforts as effort (effort)}
					<button
						type="button"
						class="focus-visible:ring-ring/60 text-foreground hover:bg-hover-fill flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm outline-none focus-visible:ring-2"
						aria-pressed={effort === reasoningEffort}
						onclick={() => selectReasoning(effort)}
					>
						<Check
							class={cn(
								'size-4 shrink-0 transition-opacity',
								effort === reasoningEffort ? 'opacity-100' : 'opacity-0'
							)}
						/>
						<span>{reasoningEffortLabel(effort)}</span>
						{#if effort === model.defaultReasoningEffort}
							<span class="text-muted-foreground ml-auto text-xs">Default</span>
						{/if}
					</button>
				{/each}
			</div>

			<div class="mx-2 my-2 h-px bg-[var(--hairline)]"></div>
			<p class="text-muted-foreground px-3 pb-1.5 text-[11px] font-medium">Service tier</p>
			<div class="space-y-0.5">
				{#each tierOptions as option (option.id)}
					{@const locked = Boolean(option.locked)}
					<button
						type="button"
						class={cn(
							'focus-visible:ring-ring/60 flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm outline-none focus-visible:ring-2',
							locked ? 'cursor-not-allowed opacity-45' : 'text-foreground hover:bg-hover-fill'
						)}
						aria-pressed={!locked && option.id === serviceTier}
						aria-disabled={locked}
						aria-label={locked && option.lockTooltip
							? `${option.label}. ${option.lockTooltip}`
							: undefined}
						onmouseenter={(event) => {
							if (locked && option.lockTooltip)
								lockTooltipState.showLockTooltip(event, option.lockTooltip);
						}}
						onmouseleave={() => lockTooltipState.hideLockTooltip()}
						onfocus={(event) => {
							if (locked && option.lockTooltip)
								lockTooltipState.showLockTooltip(event, option.lockTooltip);
						}}
						onblur={() => lockTooltipState.hideLockTooltip()}
						onclick={(event) => selectServiceTier(option.id, event)}
					>
						{#if locked}
							<span class="text-muted-foreground shrink-0" aria-hidden="true">
								<Lock class="size-3.5" />
							</span>
						{:else}
							<Check
								class={cn(
									'size-4 shrink-0 transition-opacity',
									option.id === serviceTier ? 'opacity-100' : 'opacity-0'
								)}
							/>
						{/if}
						{#if option.id === 'fast'}<Zap class="size-3.5 shrink-0 text-amber-400" />{/if}
						<span class={cn(locked && 'text-muted-foreground')}>{option.label}</span>
						{#if !locked && option.id === unlockedServiceTiers[0]}
							<span class="text-muted-foreground ml-auto text-xs">Default</span>
						{/if}
					</button>
				{/each}
			</div>
		</div>
	{/if}
</div>

<Tooltip tooltip={lockTooltipState.lockTooltip} />
