<script lang="ts">
	import BrandMark from '$lib/components/brand-mark.svelte';
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
</script>

<div
	class={cn(
		'flex min-h-screen items-center justify-center bg-[#0f1218] px-8 py-10 text-center',
		className
	)}
>
	<div
		class="w-full max-w-md"
		aria-busy={busy ? true : undefined}
		aria-live={busy ? 'polite' : undefined}
	>
		<div class="mb-8 flex justify-center">
			<BrandMark />
		</div>

		<h1 class="text-[1.35rem] font-medium tracking-tight text-slate-200">{title}</h1>
		{#if description}
			<p class="mt-3 text-sm leading-[1.55] text-slate-400">{description}</p>
		{/if}

		{#if children}
			<div class="mt-5 space-y-4 [&:not(:has(*))]:mt-0 [&:not(:has(*))]:hidden">
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
