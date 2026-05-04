<script lang="ts">
	import { cn } from '$lib/utils';

	type Props = {
		className?: string;
		children?: import('svelte').Snippet;
	};

	let { className = '', children }: Props = $props();
</script>

<div class={cn('space-y-1.5 p-6 pb-0', className)}>
	{@render children?.()}
</div>
