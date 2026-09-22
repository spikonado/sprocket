<script lang="ts">
	import { ChevronRight } from '@lucide/svelte';
	import type { Snippet } from 'svelte';
	import { formatElapsedDuration } from '$lib/format';
	import { elapsedSeconds, tickingNow } from '$lib/chat/elapsed-time';

	type Props = {
		inProgress: boolean;
		startedAtMs?: number;
		/** Durable end when the section is finished; omit while in progress. */
		completedAtMs?: number;
		children: Snippet;
	};

	let { inProgress, startedAtMs, completedAtMs, children }: Props = $props();
	let expanded = $state(false);

	function toggle() {
		expanded = !expanded;
	}

	const duration = $derived(elapsedSeconds(startedAtMs, inProgress ? tickingNow() : completedAtMs));

	const label = $derived(
		`${inProgress ? 'Working' : 'Worked'}${duration === undefined ? '' : ` for ${formatElapsedDuration(duration)}`}`
	);
</script>

<div class="text-muted-foreground text-sm">
	<button
		type="button"
		class="text-muted-foreground hover:text-muted-foreground inline-flex items-center gap-1 transition"
		onclick={toggle}
		aria-expanded={expanded}
	>
		<span>{label}</span>
		<ChevronRight
			class={`size-3.5 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
			aria-hidden="true"
		/>
	</button>
	{#if expanded}
		<div class="mt-1.5 space-y-2">
			{@render children()}
		</div>
	{/if}
</div>
