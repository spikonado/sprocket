<script lang="ts">
	import { cn } from '$lib/utils';

	type Props = {
		className?: string;
		children?: import('svelte').Snippet;
	};

	let { className = '', children }: Props = $props();
</script>

<div class={cn('flex items-center p-6 pt-0', className)}>
	{@render children?.()}
</div>
