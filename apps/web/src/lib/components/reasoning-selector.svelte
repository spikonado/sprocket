<script lang="ts">
	import { Check, ChevronDown, Lock, Zap } from '@lucide/svelte';
	import { defaultReasoningEffort } from '$convex/lib/models';
	import {
		type CatalogModel,
		type FastModeAccess,
		reasoningEffortLabel
	} from '$lib/chat/model-catalog';
	import { createLockTooltip } from '$lib/components/ui/lock-tooltip.svelte';
	import { listenOpenMenuDismiss } from '$lib/components/ui/menu-dismiss.svelte';
	import Tooltip from '$lib/components/ui/tooltip.svelte';
	import { cn } from '$lib/utils';

	type Props = {
		model: CatalogModel;
		reasoningEffort?: string;
		fastMode?: boolean;
		fastModeAccess?: FastModeAccess;
		fastModeLockTooltip?: string;
		disabled?: boolean;
		className?: string;
	};

	let {
		model,
		reasoningEffort = $bindable<string>(defaultReasoningEffort),
		fastMode = $bindable(false),
		fastModeAccess,
		fastModeLockTooltip,
		disabled = false,
		className = ''
	}: Props = $props();

	let isOpen = $state(false);
	let rootElement = $state<HTMLDivElement | null>(null);
	let triggerElement = $state<HTMLButtonElement | null>(null);
	const lockTooltipState = createLockTooltip();

	function selectReasoning(next: string) {
		reasoningEffort = next;
	}

	function toggleFastMode(event: MouseEvent) {
		if (fastModeAccess === 'locked') {
			if (fastModeLockTooltip) lockTooltipState.showLockTooltip(event, fastModeLockTooltip, true);
			return;
		}
		if (fastModeAccess === 'available') fastMode = !fastMode;
	}

	$effect(() => {
		const supportedReasoning = model.reasoningEfforts;
		if (!supportedReasoning.includes(reasoningEffort)) {
			reasoningEffort = model.defaultReasoningEffort;
		}
		if (fastModeAccess === 'unsupported' || fastModeAccess === 'locked') fastMode = false;
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
		aria-label={fastModeAccess === 'available' || fastModeAccess === 'locked'
			? 'Select reasoning effort and Fast mode'
			: 'Select reasoning effort'}
		{disabled}
		onclick={() => {
			isOpen = !isOpen;
		}}
	>
		<span
			>{reasoningEffortLabel(reasoningEffort)}{fastMode && model.supportsFastMode
				? ' · Fast'
				: ''}</span
		>
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
			aria-label={fastModeAccess === 'available' || fastModeAccess === 'locked'
				? 'Reasoning and Fast mode'
				: 'Reasoning'}
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

			{#if fastModeAccess === 'available' || fastModeAccess === 'locked'}
				{@const locked = fastModeAccess === 'locked'}
				<div class="mx-2 my-2 h-px bg-[var(--hairline)]"></div>
				<p class="text-muted-foreground px-3 pb-1.5 text-[11px] font-medium">Speed</p>
				<div class="space-y-0.5">
					<button
						type="button"
						role="switch"
						class={cn(
							'focus-visible:ring-ring/60 flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm outline-none focus-visible:ring-2',
							locked ? 'cursor-not-allowed opacity-45' : 'text-foreground hover:bg-hover-fill'
						)}
						aria-checked={!locked && fastMode}
						aria-disabled={locked}
						aria-label={locked && fastModeLockTooltip
							? `Fast mode. ${fastModeLockTooltip}`
							: undefined}
						onmouseenter={(event) => {
							if (locked && fastModeLockTooltip)
								lockTooltipState.showLockTooltip(event, fastModeLockTooltip);
						}}
						onmouseleave={() => lockTooltipState.hideLockTooltip()}
						onfocus={(event) => {
							if (locked && fastModeLockTooltip)
								lockTooltipState.showLockTooltip(event, fastModeLockTooltip);
						}}
						onblur={() => lockTooltipState.hideLockTooltip()}
						onclick={toggleFastMode}
					>
						{#if locked}
							<span class="text-muted-foreground shrink-0" aria-hidden="true">
								<Lock class="size-3.5" />
							</span>
						{:else}
							<span class="size-3.5 shrink-0" aria-hidden="true"></span>
						{/if}
						<Zap class="size-3.5 shrink-0 text-amber-400" />
						<span class={cn(locked && 'text-muted-foreground')}>Fast</span>
						<span
							class={cn(
								'relative ml-auto inline-flex h-5 w-9 shrink-0 items-center rounded-full transition',
								fastMode && !locked ? 'bg-foreground' : 'bg-hover-fill-strong'
							)}
							aria-hidden="true"
						>
							<span
								class={cn(
									'bg-background inline-block size-3.5 rounded-full transition',
									fastMode && !locked ? 'translate-x-[18px]' : 'translate-x-[3px]'
								)}
							></span>
						</span>
					</button>
				</div>
			{/if}
		</div>
	{/if}
</div>

<Tooltip tooltip={lockTooltipState.lockTooltip} />
