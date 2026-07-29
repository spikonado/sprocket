<script
	lang="ts"
	generics="TOption extends { id: string; label: string; triggerLabel?: string; locked?: boolean; lockTooltip?: string }"
>
	import { Check, ChevronDown, Lock, Search } from '@lucide/svelte';
	import { createLockTooltip } from '$lib/components/ui/lock-tooltip.svelte';
	import { listenOpenMenuDismiss } from '$lib/components/ui/menu-dismiss.svelte';
	import Tooltip from '$lib/components/ui/tooltip.svelte';
	import { cn } from '$lib/utils';

	type Props = {
		value?: string;
		options: TOption[];
		ariaLabel: string;
		menuTitle: string;
		disabled?: boolean;
		className?: string;
		triggerClassName?: string;
		searchable?: boolean;
		onValueChange?: (value: TOption['id']) => void;
		optionIcon?: import('svelte').Snippet<[TOption]>;
	};

	let {
		value = $bindable(''),
		options,
		ariaLabel,
		menuTitle,
		disabled = false,
		className = '',
		triggerClassName = '',
		searchable = false,
		onValueChange,
		optionIcon
	}: Props = $props();

	let isOpen = $state(false);
	let searchQuery = $state('');
	let rootElement = $state<HTMLDivElement | null>(null);
	let triggerElement = $state<HTMLButtonElement | null>(null);
	let searchElement = $state<HTMLInputElement | null>(null);
	const lockTooltipState = createLockTooltip();
	let selectedOption = $derived.by(() => {
		const matched = options.find((option) => option.id === value);
		if (matched && !matched.locked) return matched;
		return options.find((option) => !option.locked) ?? matched ?? options[0] ?? null;
	});
	let filteredOptions = $derived(
		searchable && searchQuery.trim()
			? options.filter((option) =>
					option.label.toLocaleLowerCase().includes(searchQuery.trim().toLocaleLowerCase())
				)
			: options
	);
	let selectableFilteredOptions = $derived(filteredOptions.filter((option) => !option.locked));

	function toggleMenu() {
		if (disabled) {
			return;
		}

		isOpen = !isOpen;
		if (isOpen && searchable) queueMicrotask(() => searchElement?.focus());
		else searchQuery = '';
	}

	function selectOption(optionId: TOption['id'], event?: MouseEvent) {
		const option = options.find((entry) => entry.id === optionId);
		if (!option) return;
		if (option.locked) {
			if (event && option.lockTooltip)
				lockTooltipState.showLockTooltip(event, option.lockTooltip, true);
			return;
		}
		if (optionId !== value) {
			value = optionId;
			onValueChange?.(optionId);
		}
		isOpen = false;
		searchQuery = '';
		lockTooltipState.hideLockTooltip(true);
		triggerElement?.focus();
	}

	function handleSearchKeydown(event: KeyboardEvent) {
		if (event.key !== 'Enter' || selectableFilteredOptions.length === 0) return;
		event.preventDefault();
		selectOption(selectableFilteredOptions[0].id);
	}

	$effect(() => {
		if (!isOpen) {
			searchQuery = '';
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
			'focus-visible:ring-ring/60 text-muted-foreground hover:bg-hover-fill inline-flex h-8 shrink-0 items-center gap-2 rounded-lg border border-transparent bg-transparent px-2 text-sm font-medium transition outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50',
			!optionIcon && 'gap-1',
			triggerClassName
		)}
		aria-haspopup="dialog"
		aria-expanded={isOpen}
		aria-label={ariaLabel}
		{disabled}
		onclick={toggleMenu}
	>
		{#if optionIcon && selectedOption}
			{@render optionIcon(selectedOption)}
		{/if}
		<span class="truncate">{selectedOption?.triggerLabel ?? selectedOption?.label ?? value}</span>
		<ChevronDown
			class={cn(
				'text-muted-foreground size-3 shrink-0 transition-transform',
				isOpen && 'rotate-180'
			)}
		/>
	</button>

	{#if isOpen}
		<div
			class="bg-popover/96 absolute bottom-[calc(100%+0.75rem)] left-0 z-50 min-w-[19rem] rounded-[18px] border border-[var(--hairline)] p-2 shadow-[var(--composer-shadow)] backdrop-blur-xl"
			role="dialog"
			aria-label={menuTitle}
		>
			{#if searchable}
				<label
					class="text-muted-foreground flex h-10 items-center gap-2 border-b border-[var(--hairline)] px-2"
				>
					<Search class="size-4 shrink-0" />
					<span class="sr-only">Search {menuTitle.toLocaleLowerCase()}</span>
					<input
						bind:this={searchElement}
						bind:value={searchQuery}
						class="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
						placeholder={`Search ${menuTitle.toLocaleLowerCase()}…`}
						onkeydown={handleSearchKeydown}
					/>
				</label>
			{:else}
				<p class="text-muted-foreground px-3 pt-1 pb-2 text-[11px] font-medium">{menuTitle}</p>
			{/if}

			<div class={cn('space-y-0.5', searchable && 'pt-1.5')}>
				{#each filteredOptions as option (option.id)}
					{@const locked = Boolean(option.locked)}
					<button
						type="button"
						class={cn(
							'focus-visible:ring-ring/60 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left outline-none focus-visible:ring-2',
							locked ? 'cursor-not-allowed opacity-45' : 'hover:bg-hover-fill',
							!locked && option.id === value && 'bg-hover-fill'
						)}
						aria-pressed={!locked && option.id === value}
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
						onclick={(event) => {
							selectOption(option.id, event);
						}}
					>
						{#if optionIcon}
							<span
								class={cn(
									'flex size-7 shrink-0 items-center justify-center',
									locked ? 'text-muted-foreground' : 'text-muted-foreground'
								)}
							>
								{@render optionIcon(option)}
							</span>
						{/if}
						<span
							class={cn(
								'min-w-0 flex-1 truncate text-sm font-medium',
								locked ? 'text-muted-foreground' : 'text-foreground'
							)}>{option.label}</span
						>
						{#if locked}
							<span class="text-muted-foreground shrink-0" aria-hidden="true">
								<Lock class="size-3.5" />
							</span>
						{:else}
							<Check
								class={cn(
									'text-accent-strong size-4 shrink-0 transition-opacity',
									option.id === value ? 'opacity-100' : 'opacity-0'
								)}
							/>
						{/if}
					</button>
				{/each}
				{#if filteredOptions.length === 0}
					<p class="text-muted-foreground px-3 py-5 text-center text-sm">No matches found</p>
				{/if}
			</div>
		</div>
	{/if}
</div>

<Tooltip tooltip={lockTooltipState.lockTooltip} />
