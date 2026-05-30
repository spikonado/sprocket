<script lang="ts">
	import { cn } from '$lib/utils';

	type Props = {
		className?: string;
		viewport?: HTMLDivElement | null;
		onViewportScroll?: () => void;
		children?: import('svelte').Snippet;
	};

	let { className = '', viewport = $bindable(null), onViewportScroll, children }: Props = $props();
</script>

<div
	class={cn('overflow-auto', className)}
	bind:this={viewport}
	onscroll={() => {
		onViewportScroll?.();
	}}
>
	{@render children?.()}
</div>
