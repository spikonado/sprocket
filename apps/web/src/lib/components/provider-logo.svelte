<script lang="ts">
	import OpenAIBlossom from '$lib/components/openai-blossom.svelte';
	import { cn } from '$lib/utils';

	type Props = {
		/** Provider id from the model catalog; unknown values get a neutral glyph. */
		provider: string;
		className?: string;
	};

	let { provider, className = '' }: Props = $props();
</script>

{#if provider === 'openai'}
	<OpenAIBlossom className={cn('size-4 text-foreground', className)} />
{:else if provider === 'anthropic'}
	<svg
		viewBox="0 0 24 24"
		class={cn('size-4 text-[#D97757]', className)}
		role="img"
		aria-label="Anthropic"
		fill="currentColor"
	>
		<path
			d="M17.304 3.541h-3.672l6.696 16.918H24Zm-10.608 0L0 20.459h3.744l1.37-3.553h7.005l1.369 3.553h3.744L10.536 3.541Zm-.371 10.223 2.291-5.945 2.292 5.945Z"
		/>
	</svg>
{:else if provider === 'xai'}
	<svg
		viewBox="0 0 24 24"
		class={cn('text-foreground size-4', className)}
		role="img"
		aria-label="xAI"
		fill="currentColor"
	>
		<path
			d="M6.469 8.776 16.512 23h-4.464L2.005 8.776H6.47Zm-.004 7.9 2.233 3.164L6.467 23H2l4.465-6.324ZM22 2.582V23h-3.659V7.764L22 2.582ZM22 1l-9.952 14.095-2.233-3.163L17.533 1H22Z"
		/>
	</svg>
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
