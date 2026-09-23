<script lang="ts">
	import { cn } from '$lib/utils';

	type Props = {
		class?: string;
		size?: 'sm' | 'md';
		onclick?: () => void;
		label?: string;
	};

	let { class: className = '', size = 'md', onclick, label }: Props = $props();

	const sizeClass = $derived(size === 'sm' ? 'h-6 w-6' : 'h-7 w-7');
	const textClass = $derived(size === 'sm' ? 'text-lg' : 'text-[1.15rem]');
</script>

{#if onclick}
	<button
		type="button"
		class={cn('flex min-w-0 items-center gap-2', className)}
		aria-label={label}
		title={label}
		{onclick}
	>
		<img src="/logo.png" alt="" class={cn('shrink-0', sizeClass)} />
		<span class={cn('font-brand text-foreground truncate font-semibold tracking-tight', textClass)}>
			Sprocket
		</span>
	</button>
{:else}
	<div class={cn('flex min-w-0 items-center gap-2', className)}>
		<img src="/logo.png" alt="" class={cn('shrink-0', sizeClass)} />
		<span class={cn('font-brand text-foreground truncate font-semibold tracking-tight', textClass)}>
			Sprocket
		</span>
	</div>
{/if}
