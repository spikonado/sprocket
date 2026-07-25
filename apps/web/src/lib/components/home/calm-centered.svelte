<script lang="ts">
	import { onMount } from 'svelte';
	import BrandMark from '$lib/components/brand-mark.svelte';
	import { forceEntryTheme } from '$lib/theme';
	import { cn } from '$lib/utils';

	type Props = {
		title: string;
		description?: string | null;
		busy?: boolean;
		class?: string;
		children?: import('svelte').Snippet;
		actions?: import('svelte').Snippet;
	};

	let {
		title,
		description = null,
		busy = false,
		class: className = '',
		children,
		actions
	}: Props = $props();

	onMount(() => forceEntryTheme());
</script>

<div
	class={cn(
		'app-entry-shell relative flex min-h-screen items-center justify-center px-8 py-10 text-center',
		className
	)}
>
	<div
		class="relative z-10 w-full max-w-md"
		aria-busy={busy ? true : undefined}
		aria-live={busy ? 'polite' : undefined}
	>
		<div class="mb-8 flex justify-center">
			<BrandMark />
		</div>

		<h1 class="font-brand text-foreground text-[1.5rem] font-semibold tracking-tight">{title}</h1>
		{#if description}
			<p class="text-muted-foreground mt-3 text-sm leading-[1.55]">{description}</p>
		{/if}

		{#if children}
			<div class="mt-5 space-y-4 text-left [&:not(:has(*))]:mt-0 [&:not(:has(*))]:hidden">
				{@render children()}
			</div>
		{/if}

		{#if actions}
			<div
				class="mt-6 flex flex-wrap items-center justify-center gap-3 [&:not(:has(*))]:mt-0 [&:not(:has(*))]:hidden"
			>
				{@render actions()}
			</div>
		{/if}
	</div>
</div>
