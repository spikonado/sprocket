<script
	lang="ts"
	generics="TOption extends { id: string; label: string; triggerLabel?: string; locked?: boolean; lockTooltip?: string }"
>
	import { Check, ChevronDown, Lock, Search } from '@lucide/svelte';
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
	let lockTooltip = $state<{ top: number; left: number; label: string } | null>(null);
	let stickyLockTooltip = $state(false);
	let stickyLockTooltipTimer: ReturnType<typeof setTimeout> | null = null;
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
			if (event && option.lockTooltip) showLockTooltip(event, option.lockTooltip, true);
			return;
		}
		if (optionId !== value) {
			value = optionId;
			onValueChange?.(optionId);
		}
		isOpen = false;
		searchQuery = '';
		hideLockTooltip(true);
		triggerElement?.focus();
	}

	function handleSearchKeydown(event: KeyboardEvent) {
		if (event.key !== 'Enter' || selectableFilteredOptions.length === 0) return;
		event.preventDefault();
		selectOption(selectableFilteredOptions[0].id);
	}

	function clearStickyLockTooltipTimer() {
		if (!stickyLockTooltipTimer) return;
		clearTimeout(stickyLockTooltipTimer);
		stickyLockTooltipTimer = null;
	}

	function showLockTooltip(event: MouseEvent | FocusEvent, label: string, sticky = false) {
		const target = event.currentTarget;
		if (!(target instanceof HTMLElement)) return;
		const rect = target.getBoundingClientRect();
		clearStickyLockTooltipTimer();
		stickyLockTooltip = sticky;
		lockTooltip = {
			top: rect.top - 8,
			left: rect.left + rect.width / 2,
			label
		};
		if (sticky) {
			stickyLockTooltipTimer = setTimeout(() => {
				stickyLockTooltip = false;
				stickyLockTooltipTimer = null;
				lockTooltip = null;
			}, 2500);
		}
	}

	function hideLockTooltip(force = false) {
		if (stickyLockTooltip && !force) return;
		clearStickyLockTooltipTimer();
		stickyLockTooltip = false;
		lockTooltip = null;
	}

	$effect(() => {
		if (!isOpen) {
			searchQuery = '';
			hideLockTooltip();
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
			'focus-visible:ring-ring/60 inline-flex h-8 shrink-0 items-center gap-2 rounded-lg border border-transparent bg-transparent px-2 text-sm font-medium text-slate-300 transition outline-none hover:bg-white/[0.03] focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50',
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
			class={cn('size-3 shrink-0 text-slate-500 transition-transform', isOpen && 'rotate-180')}
		/>
	</button>

	{#if isOpen}
		<div
			class="bg-popover/96 absolute bottom-[calc(100%+0.75rem)] left-0 z-50 min-w-[19rem] rounded-[18px] border border-white/8 p-2 shadow-[0_28px_80px_rgba(0,0,0,0.42)] backdrop-blur-xl"
			role="dialog"
			aria-label={menuTitle}
		>
			{#if searchable}
				<label class="flex h-10 items-center gap-2 border-b border-white/6 px-2 text-slate-400">
					<Search class="size-4 shrink-0" />
					<span class="sr-only">Search {menuTitle.toLocaleLowerCase()}</span>
					<input
						bind:this={searchElement}
						bind:value={searchQuery}
						class="min-w-0 flex-1 bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-500"
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
							locked ? 'cursor-not-allowed opacity-45' : 'hover:bg-white/4',
							!locked && option.id === value && 'bg-white/[0.035]'
						)}
						aria-pressed={!locked && option.id === value}
						aria-disabled={locked}
						aria-label={locked && option.lockTooltip
							? `${option.label}. ${option.lockTooltip}`
							: undefined}
						onmouseenter={(event) => {
							if (locked && option.lockTooltip) showLockTooltip(event, option.lockTooltip);
						}}
						onmouseleave={() => hideLockTooltip()}
						onfocus={(event) => {
							if (locked && option.lockTooltip) showLockTooltip(event, option.lockTooltip);
						}}
						onblur={() => hideLockTooltip()}
						onclick={(event) => {
							selectOption(option.id, event);
						}}
					>
						{#if optionIcon}
							<span
								class={cn(
									'flex size-7 shrink-0 items-center justify-center',
									locked ? 'text-slate-500' : 'text-slate-300'
								)}
							>
								{@render optionIcon(option)}
							</span>
						{/if}
						<span
							class={cn(
								'min-w-0 flex-1 truncate text-sm font-medium',
								locked ? 'text-slate-400' : 'text-slate-100'
							)}>{option.label}</span
						>
						{#if locked}
							<span class="shrink-0 text-slate-500" aria-hidden="true">
								<Lock class="size-3.5" />
							</span>
						{:else}
							<Check
								class={cn(
									'size-4 shrink-0 text-blue-400 transition-opacity',
									option.id === value ? 'opacity-100' : 'opacity-0'
								)}
							/>
						{/if}
					</button>
				{/each}
				{#if filteredOptions.length === 0}
					<p class="px-3 py-5 text-center text-sm text-slate-500">No matches found</p>
				{/if}
			</div>
		</div>
	{/if}
</div>

{#if lockTooltip}
	<div
		class="pointer-events-none fixed z-100 -translate-x-1/2 -translate-y-full rounded-md bg-[#1a1d27] px-2.5 py-1.5 text-[12px] leading-4 whitespace-nowrap text-slate-100 shadow-lg ring-1 ring-white/10"
		style={`top: ${lockTooltip.top}px; left: ${lockTooltip.left}px;`}
		role="tooltip"
	>
		{lockTooltip.label}
	</div>
{/if}
