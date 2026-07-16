<script lang="ts">
	import { cn } from '$lib/utils';

	type Props = {
		class?: string;
		size?: 'sm' | 'md';
	};

	let { class: className = '', size = 'md' }: Props = $props();

	const sizeClass = $derived(size === 'sm' ? 'h-6 w-6' : 'h-7 w-7');
	const textClass = $derived(size === 'sm' ? 'text-lg' : 'text-[1.15rem]');
</script>

<div class={cn('flex min-w-0 items-center gap-2', className)}>
	<img src="/logo.png" alt="" class={cn('shrink-0', sizeClass)} />
	<span class={cn('font-brand truncate font-normal tracking-tight text-white', textClass)}>
		Sprocket
	</span>
</div>
