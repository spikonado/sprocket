<script lang="ts">
	import { cn } from '$lib/utils';

	type Props = {
		/** Provider id from the model catalog; must match a slug under https://models.dev/logos/. */
		provider: string;
		className?: string;
	};

	let { provider, className = '' }: Props = $props();

	let failed = $state(false);
</script>

{#if provider === 'spikonado'}
	<img src="/logo.png" alt="" class={cn('size-4 shrink-0', className)} />
{:else if !failed}
	<img
		src="https://models.dev/logos/{provider}.svg"
		alt=""
		class={cn('size-4 shrink-0 dark:invert', className)}
		onerror={() => (failed = true)}
	/>
{:else}
	<svg
		viewBox="0 0 24 24"
		class={cn('text-muted-foreground size-4', className)}
		role="img"
		aria-label={provider || 'Unknown provider'}
		fill="none"
		stroke="currentColor"
		stroke-width="1.5"
	>
		<circle cx="12" cy="12" r="9" />
		<path d="M12 8v4l2.5 1.5" stroke-linecap="round" stroke-linejoin="round" />
	</svg>
{/if}
