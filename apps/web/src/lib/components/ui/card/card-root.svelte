<script lang="ts">
	import { cn } from '$lib/utils';

	type Props = {
		className?: string;
		children?: import('svelte').Snippet;
	};

	let { className = '', children }: Props = $props();
</script>

<section class={cn('bg-card text-card-foreground rounded-[28px] border', className)}>
	{@render children?.()}
</section>
