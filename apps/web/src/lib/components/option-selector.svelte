<script lang="ts" generics="TOption extends { id: string; label: string; triggerLabel?: string }">
	import { Check, ChevronDown, Search } from '@lucide/svelte';
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
		optionIcon
	}: Props = $props();

	let isOpen = $state(false);
	let searchQuery = $state('');
	let rootElement = $state<HTMLDivElement | null>(null);
	let triggerElement = $state<HTMLButtonElement | null>(null);
	let searchElement = $state<HTMLInputElement | null>(null);
	let selectedOption = $derived(
		options.find((option) => option.id === value) ?? options[0] ?? null
	);
	let filteredOptions = $derived(
		searchable && searchQuery.trim()
			? options.filter((option) =>
					option.label.toLocaleLowerCase().includes(searchQuery.trim().toLocaleLowerCase())
				)
			: options
	);

	function toggleMenu() {
		if (disabled) {
			return;
		}

		isOpen = !isOpen;
		if (isOpen && searchable) queueMicrotask(() => searchElement?.focus());
		else searchQuery = '';
	}

	function selectOption(optionId: string) {
		value = optionId;
		isOpen = false;
		searchQuery = '';
		triggerElement?.focus();
	}

	function handleSearchKeydown(event: KeyboardEvent) {
		if (event.key !== 'Enter' || filteredOptions.length === 0) return;
		event.preventDefault();
		selectOption(filteredOptions[0].id);
	}

	$effect(() => {
		if (!isOpen) {
			searchQuery = '';
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
					<button
						type="button"
						class={cn(
							'focus-visible:ring-ring/60 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left outline-none hover:bg-white/4 focus-visible:ring-2',
							option.id === value && 'bg-white/[0.035]'
						)}
						aria-pressed={option.id === value}
						onclick={() => {
							selectOption(option.id);
						}}
					>
						{#if optionIcon}
							<span class="flex size-7 shrink-0 items-center justify-center text-slate-300">
								{@render optionIcon(option)}
							</span>
						{/if}
						<span class="min-w-0 flex-1 truncate text-sm font-medium text-slate-100"
							>{option.label}</span
						>
						<Check
							class={cn(
								'size-4 shrink-0 text-blue-400 transition-opacity',
								option.id === value ? 'opacity-100' : 'opacity-0'
							)}
						/>
					</button>
				{/each}
				{#if filteredOptions.length === 0}
					<p class="px-3 py-5 text-center text-sm text-slate-500">No matches found</p>
				{/if}
			</div>
		</div>
	{/if}
</div>
