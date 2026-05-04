<script lang="ts">
	import { cn } from '$lib/utils';

	type Props = {
		className?: string;
		children?: import('svelte').Snippet;
	};

	let { className = '', children }: Props = $props();
</script>

<p class={cn('text-muted-foreground text-sm', className)}>
	{@render children?.()}
</p>
