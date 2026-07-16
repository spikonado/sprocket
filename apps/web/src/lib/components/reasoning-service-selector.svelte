<script lang="ts">
	import { Check, ChevronDown, Zap } from '@lucide/svelte';
	import {
		defaultReasoningEffort,
		defaultServiceTier,
		getModelDefinition,
		serviceTierIds,
		type SupportedModelId,
		type SupportedReasoningEffort,
		type SupportedServiceTier
	} from '$convex/lib/models';
	import { reasoningEffortLabels, serviceTierLabels } from '$lib/chat/model-options';
	import { cn } from '$lib/utils';

	type Props = {
		modelId: SupportedModelId;
		reasoningEffort?: SupportedReasoningEffort;
		serviceTier?: SupportedServiceTier;
		disabled?: boolean;
		className?: string;
	};

	let {
		modelId,
		reasoningEffort = $bindable(defaultReasoningEffort),
		serviceTier = $bindable(defaultServiceTier),
		disabled = false,
		className = ''
	}: Props = $props();

	let isOpen = $state(false);
	let rootElement = $state<HTMLDivElement | null>(null);
	let triggerElement = $state<HTMLButtonElement | null>(null);
	let model = $derived(getModelDefinition(modelId));
	let supportsFast = $derived(model.serviceTiers.includes('fast'));

	function selectReasoning(next: SupportedReasoningEffort) {
		reasoningEffort = next;
	}

	function selectServiceTier(next: SupportedServiceTier) {
		if (next === 'fast' && !supportsFast) return;
		serviceTier = next;
	}

	$effect(() => {
		const supportedReasoning = model.reasoningEfforts as readonly SupportedReasoningEffort[];
		if (!supportedReasoning.includes(reasoningEffort)) {
			reasoningEffort = model.defaultReasoningEffort;
		}
		if (!model.serviceTiers.includes(serviceTier)) serviceTier = defaultServiceTier;
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
		class="focus-visible:ring-ring/60 inline-flex h-9 shrink-0 items-center gap-1 rounded-lg px-2 text-[15px] text-slate-300 outline-none transition hover:bg-white/[0.03] focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50"
		aria-haspopup="dialog"
		aria-expanded={isOpen}
		aria-label="Select reasoning effort and service tier"
		{disabled}
		onclick={() => {
			isOpen = !isOpen;
		}}
	>
		<span>{reasoningEffortLabels[reasoningEffort]} · {serviceTierLabels[serviceTier]}</span>
		<ChevronDown
			class={cn('size-3 shrink-0 text-slate-500 transition-transform', isOpen && 'rotate-180')}
		/>
	</button>

	{#if isOpen}
		<div
			class="bg-popover/96 absolute bottom-[calc(100%+0.75rem)] left-0 z-50 min-w-[15rem] rounded-[18px] border border-white/8 p-2 shadow-[0_28px_80px_rgba(0,0,0,0.42)] backdrop-blur-xl"
			role="dialog"
			aria-label="Reasoning and service tier"
		>
			<p class="px-3 pt-1 pb-1.5 text-[11px] font-medium text-slate-500">Reasoning</p>
			<div class="space-y-0.5">
				{#each model.reasoningEfforts as effort (effort)}
					<button
						type="button"
						class="focus-visible:ring-ring/60 flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-slate-100 outline-none hover:bg-white/4 focus-visible:ring-2"
						aria-pressed={effort === reasoningEffort}
						onclick={() => selectReasoning(effort)}
					>
						<Check
							class={cn(
								'size-4 shrink-0 transition-opacity',
								effort === reasoningEffort ? 'opacity-100' : 'opacity-0'
							)}
						/>
						<span>{reasoningEffortLabels[effort]}</span>
						{#if effort === model.defaultReasoningEffort}
							<span class="ml-auto text-xs text-slate-500">Default</span>
						{/if}
					</button>
				{/each}
			</div>

			<div class="mx-2 my-2 h-px bg-white/6"></div>
			<p class="px-3 pb-1.5 text-[11px] font-medium text-slate-500">Service tier</p>
			<div class="space-y-0.5">
				{#each serviceTierIds as tier (tier)}
					{@const unavailable = tier === 'fast' && !supportsFast}
					<button
						type="button"
						class={cn(
							'focus-visible:ring-ring/60 flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-slate-100 outline-none focus-visible:ring-2',
							unavailable ? 'cursor-not-allowed opacity-40' : 'hover:bg-white/4'
						)}
						aria-pressed={tier === serviceTier}
						aria-disabled={unavailable}
						onclick={() => selectServiceTier(tier)}
					>
						<Check
							class={cn(
								'size-4 shrink-0 transition-opacity',
								tier === serviceTier ? 'opacity-100' : 'opacity-0'
							)}
						/>
						{#if tier === 'fast'}<Zap class="size-3.5 text-amber-400" />{/if}
						<span>{serviceTierLabels[tier]}</span>
						{#if unavailable}
							<span class="ml-auto text-xs text-slate-500">Unavailable</span>
						{:else if tier === defaultServiceTier}
							<span class="ml-auto text-xs text-slate-500">Default</span>
						{/if}
					</button>
				{/each}
			</div>
		</div>
	{/if}
</div>
