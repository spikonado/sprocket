<script lang="ts">
	import { cn } from '$lib/utils';

	type Props = {
		id?: string;
		value?: string;
		placeholder?: string;
		className?: string;
		disabled?: boolean;
		type?: string;
	};

	let {
		id,
		value = $bindable(''),
		placeholder = '',
		className = '',
		disabled = false,
		type = 'text'
	}: Props = $props();
</script>

<input
	{id}
	bind:value
	{placeholder}
	{disabled}
	{type}
	class={cn(
		'border-input bg-background/55 text-foreground placeholder:text-muted-foreground focus-visible:ring-ring/60 h-10 w-full rounded-xl border px-3.5 text-sm transition outline-none focus-visible:ring-2',
		className
	)}
/>
