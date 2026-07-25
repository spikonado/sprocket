<script lang="ts">
	import { cn } from '$lib/utils';

	type Props = {
		type?: 'button' | 'submit' | 'reset';
		variant?: 'default' | 'outline';
		className?: string;
		disabled?: boolean;
		onclick?: (event: MouseEvent) => void;
		children?: import('svelte').Snippet;
	};

	let {
		type = 'button',
		variant = 'default',
		className = '',
		disabled = false,
		onclick,
		children
	}: Props = $props();

	const variantClass = $derived(
		variant === 'outline'
			? 'border-border/90 bg-background/30 text-foreground hover:border-white/14 hover:bg-white/4'
			: 'bg-primary text-primary-foreground hover:bg-primary/92'
	);
</script>

<button
	{type}
	{disabled}
	class={cn(
		'focus-visible:ring-ring/70 inline-flex h-10 items-center justify-center rounded-xl border border-transparent px-4 py-2 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
		variantClass,
		className
	)}
	{onclick}
>
	{@render children?.()}
</button>
