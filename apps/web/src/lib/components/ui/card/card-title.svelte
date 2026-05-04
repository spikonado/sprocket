<script lang="ts">
	import { cn } from '$lib/utils';

	type Props = {
		className?: string;
		children?: import('svelte').Snippet;
	};

	let { className = '', children }: Props = $props();
</script>

<h3 class={cn('text-lg font-semibold tracking-tight text-white', className)}>
	{@render children?.()}
</h3>
