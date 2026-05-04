<script lang="ts">
	import { cn } from '$lib/utils';

	type Props = {
		className?: string;
	};

	let { className = '' }: Props = $props();
</script>

<div aria-hidden="true" class={cn('bg-border h-px w-full', className)}></div>
