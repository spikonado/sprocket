<script lang="ts">
	import type { ResolvedPathname } from '$app/types';
	import { cn } from '$lib/utils';

	type Props = {
		type?: 'button' | 'submit' | 'reset';
		variant?: 'default' | 'outline';
		className?: string;
		disabled?: boolean;
		href?: ResolvedPathname;
		onclick?: (event: MouseEvent) => void;
		children?: import('svelte').Snippet;
	};

	let {
		type = 'button',
		variant = 'default',
		className = '',
		disabled = false,
		href,
		onclick,
		children
	}: Props = $props();

	const variantClass = $derived(
		variant === 'outline'
			? 'border-border bg-surface/80 text-foreground hover:bg-hover-fill'
			: 'bg-primary text-primary-foreground hover:opacity-90'
	);
	const sharedClass = $derived(
		cn(
			'focus-visible:ring-ring/50 inline-flex h-10 items-center justify-center gap-2 rounded-full border border-transparent px-5 py-2 text-sm font-medium transition-opacity focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
			variantClass,
			className
		)
	);
</script>

{#if href && !disabled}
	<a {href} class={sharedClass} {onclick}>
		{@render children?.()}
	</a>
{:else}
	<button {type} {disabled} class={sharedClass} {onclick}>
		{@render children?.()}
	</button>
{/if}
