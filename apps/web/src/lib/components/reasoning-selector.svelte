<script lang="ts">
	import { Check, ChevronDown } from '@lucide/svelte';
	import { defaultReasoningEffort } from '$convex/lib/models';
	import type { SupportedReasoningEffort } from '$convex/lib/models';
	import { reasoningEffortOptions } from '$lib/chat/model-options';
	import { cn } from '$lib/utils';

	type Props = {
		value?: SupportedReasoningEffort;
		disabled?: boolean;
		className?: string;
		triggerClassName?: string;
	};

	let {
		value = $bindable(defaultReasoningEffort),
		disabled = false,
		className = '',
		triggerClassName = ''
	}: Props = $props();

	let isOpen = $state(false);
	let rootElement = $state<HTMLDivElement | null>(null);
	let triggerElement = $state<HTMLButtonElement | null>(null);
	let selectedOption = $derived(
		reasoningEffortOptions.find((option) => option.id === value) ??
			reasoningEffortOptions[0] ??
			null
	);

	function toggleMenu() {
		if (disabled) {
			return;
		}

		isOpen = !isOpen;
	}

	function selectOption(optionId: SupportedReasoningEffort) {
		value = optionId;
		isOpen = false;
		triggerElement?.focus();
	}

	$effect(() => {
		if (!isOpen) {
			return;
		}

		function handlePointerDown(event: PointerEvent) {
			const target = event.target;
			if (!(target instanceof Node)) {
				return;
			}

			if (!rootElement?.contains(target)) {
				isOpen = false;
			}
		}

		function handleKeyDown(event: KeyboardEvent) {
			if (event.key !== 'Escape') {
				return;
			}

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
		if (disabled) {
			isOpen = false;
		}
	});
</script>

<div bind:this={rootElement} class={cn('relative', className)}>
	<button
		bind:this={triggerElement}
		type="button"
		class={cn(
			'focus-visible:ring-ring/60 inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-transparent bg-transparent px-2 text-sm font-medium text-slate-300 transition outline-none hover:bg-white/[0.03] focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50',
			triggerClassName
		)}
		aria-haspopup="menu"
		aria-expanded={isOpen}
		aria-label="Select reasoning effort"
		{disabled}
		onclick={toggleMenu}
	>
		<span class="truncate">{selectedOption?.triggerLabel ?? selectedOption?.label ?? value}</span>
		<ChevronDown
			class={cn('size-3 shrink-0 text-slate-500 transition-transform', isOpen && 'rotate-180')}
		/>
	</button>

	{#if isOpen}
		<div
			class="bg-popover/96 absolute bottom-[calc(100%+0.75rem)] left-0 z-50 min-w-[15rem] rounded-[22px] border border-white/8 p-2 shadow-[0_28px_80px_rgba(0,0,0,0.42)] backdrop-blur-xl"
		>
			<p class="text-muted-foreground px-3 pt-1 pb-2 text-[11px] tracking-[0.22em] uppercase">
				Reasoning
			</p>

			<div class="space-y-1">
				{#each reasoningEffortOptions as option (option.id)}
					<button
						type="button"
						class="focus-visible:ring-ring/60 flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left outline-none hover:bg-white/4 focus-visible:ring-2"
						aria-pressed={option.id === value}
						onclick={() => {
							selectOption(option.id);
						}}
					>
						<Check
							class={cn(
								'size-4 shrink-0 text-slate-100 transition-opacity',
								option.id === value ? 'opacity-100' : 'opacity-0'
							)}
						/>
						<span class="truncate text-sm text-slate-100">{option.label}</span>
					</button>
				{/each}
			</div>
		</div>
	{/if}
</div>
