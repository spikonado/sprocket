<script lang="ts">
	import { Check, ChevronDown, Zap } from '@lucide/svelte';
	import {
		defaultReasoningEffort,
		defaultServiceTier,
		type SupportedReasoningEffort,
		type SupportedServiceTier
	} from '$convex/lib/models';
	import {
		type CatalogModel,
		reasoningEffortLabel,
		serviceTierLabel
	} from '$lib/chat/model-catalog';
	import { cn } from '$lib/utils';

	type Props = {
		model: CatalogModel;
		reasoningEffort?: SupportedReasoningEffort;
		serviceTier?: SupportedServiceTier;
		disabled?: boolean;
		className?: string;
	};

	let {
		model,
		reasoningEffort = $bindable<SupportedReasoningEffort>(defaultReasoningEffort),
		serviceTier = $bindable<SupportedServiceTier>(defaultServiceTier),
		disabled = false,
		className = ''
	}: Props = $props();

	let isOpen = $state(false);
	let rootElement = $state<HTMLDivElement | null>(null);
	let triggerElement = $state<HTMLButtonElement | null>(null);

	function selectReasoning(next: SupportedReasoningEffort) {
		reasoningEffort = next;
	}

	function selectServiceTier(next: SupportedServiceTier) {
		if (!model.serviceTiers.includes(next)) return;
		serviceTier = next;
	}

	$effect(() => {
		const supportedReasoning = model.reasoningEfforts;
		if (!supportedReasoning.includes(reasoningEffort)) {
			reasoningEffort = model.defaultReasoningEffort;
		}
		if (!model.serviceTiers.includes(serviceTier)) {
			serviceTier = model.serviceTiers[0] ?? defaultServiceTier;
		}
	});

	$effect(() => {
		if (!isOpen) return;

		function handlePointerDown(event: PointerEvent) {
			if (event.target instanceof Node && !rootElement?.contains(event.target)) isOpen = false;
		}

		function handleKeyDown(event: KeyboardEvent) {
			if (event.key !== 'Escape') return;
			isOpen = false;
			triggerElement?.focus();
		}

		document.addEventListener('pointerdown', handlePointerDown);
		document.addEventListener('keydown', handleKeyDown);
		return () => {
			document.removeEventListener('pointerdown', handlePointerDown);
			document.removeEventListener('keydown', handleKeyDown);
		};
	});

	$effect(() => {
		if (disabled) isOpen = false;
	});
</script>

<div bind:this={rootElement} class={cn('relative', className)}>
	<button
		bind:this={triggerElement}
		type="button"
		class="focus-visible:ring-ring/60 text-muted-foreground inline-flex h-9 shrink-0 items-center gap-1 rounded-lg px-2 text-[15px] transition outline-none hover:bg-[var(--hover-fill)] focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50"
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
						class="focus-visible:ring-ring/60 text-foreground flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm outline-none hover:bg-[var(--hover-fill)] focus-visible:ring-2"
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
				{#each model.serviceTiers as tier (tier)}
					<button
						type="button"
						class="focus-visible:ring-ring/60 text-foreground flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm outline-none hover:bg-[var(--hover-fill)] focus-visible:ring-2"
						aria-pressed={tier === serviceTier}
						onclick={() => selectServiceTier(tier)}
					>
						<Check
							class={cn(
								'size-4 shrink-0 transition-opacity',
								tier === serviceTier ? 'opacity-100' : 'opacity-0'
							)}
						/>
						{#if tier === 'fast'}<Zap class="size-3.5 text-amber-400" />{/if}
						<span>{serviceTierLabel(tier)}</span>
						{#if tier === model.serviceTiers[0]}
							<span class="text-muted-foreground ml-auto text-xs">Default</span>
						{/if}
					</button>
				{/each}
			</div>
		</div>
	{/if}
</div>
