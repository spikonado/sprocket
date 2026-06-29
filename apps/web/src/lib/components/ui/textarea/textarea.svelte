<script lang="ts">
	import { cn } from '$lib/utils';

	type Props = {
		value?: string;
		placeholder?: string;
		className?: string;
		disabled?: boolean;
	};

	let {
		value = $bindable(''),
		placeholder = '',
		className = '',
		disabled = false
	}: Props = $props();
</script>

<textarea
	bind:value
	{placeholder}
	{disabled}
	class={cn(
		'border-input bg-background/55 text-foreground placeholder:text-muted-foreground focus-visible:ring-ring/60 flex min-h-28 w-full rounded-2xl border px-4 py-3 text-sm transition outline-none focus-visible:ring-2',
		className
	)}></textarea>
