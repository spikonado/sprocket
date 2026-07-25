<script lang="ts">
	import { ChevronRight } from '@lucide/svelte';
	import type { Snippet } from 'svelte';
	import { formatElapsedDuration } from '$lib/format';

	type Props = {
		inProgress: boolean;
		/** Durable Convex/job/run wall-clock start for this work section. */
		startedAtMs: number;
		/** Durable end when the section is finished; omit while in progress. */
		completedAtMs?: number;
		children: Snippet;
	};

	let { inProgress, startedAtMs, completedAtMs, children }: Props = $props();

	let elapsedSeconds = $state(0);
	let manuallyExpanded = $state(false);
	let manuallyCollapsed = $state(false);

	$effect(() => {
		if (inProgress) {
			manuallyCollapsed = false;
		} else {
			manuallyExpanded = false;
		}
	});

	$effect(() => {
		const start = startedAtMs;

		if (inProgress) {
			const tick = () => {
				elapsedSeconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
			};
			tick();
			const intervalId = window.setInterval(tick, 1000);
			return () => {
				window.clearInterval(intervalId);
			};
		}

		const end = completedAtMs ?? Date.now();
		elapsedSeconds = Math.max(0, Math.floor((end - start) / 1000));
	});

	const expanded = $derived(inProgress ? !manuallyCollapsed : manuallyExpanded);
	const label = $derived(
		inProgress
			? `Working for ${formatElapsedDuration(elapsedSeconds)}`
			: `Worked for ${formatElapsedDuration(elapsedSeconds)}`
	);

	function toggle() {
		if (inProgress) {
			manuallyCollapsed = !manuallyCollapsed;
		} else {
			manuallyExpanded = !manuallyExpanded;
		}
	}
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
