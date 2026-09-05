<script lang="ts">
	import { ChevronRight } from '@lucide/svelte';
	import { untrack, type Snippet } from 'svelte';
	import { createInProgressDisclosure } from '$lib/components/home/in-progress-disclosure.svelte';
	import { formatElapsedDuration } from '$lib/format';
	import { elapsedSeconds, tickingNow } from '$lib/chat/elapsed-time';

	type Props = {
		inProgress: boolean;
		startedAtMs?: number;
		/** Durable end when the section is finished; omit while in progress. */
		completedAtMs?: number;
		children: Snippet;
		onExpand?: () => void | Promise<void>;
		detailsKey?: string;
	};

	let { inProgress, startedAtMs, completedAtMs, children, onExpand, detailsKey }: Props = $props();
	let loadError = $state(false);

	function toggle() {
		disclosure.toggle();
	}

	const duration = $derived(elapsedSeconds(startedAtMs, inProgress ? tickingNow() : completedAtMs));
	const disclosure = createInProgressDisclosure(() => inProgress);

	$effect(() => {
		void detailsKey;
		if (!disclosure.expanded) return;
		let cancelled = false;
		loadError = false;
		void Promise.resolve(untrack(() => onExpand?.())).catch(() => {
			if (!cancelled) loadError = true;
		});
		return () => {
			cancelled = true;
		};
	});

	const label = $derived(
		`${inProgress ? 'Working' : 'Worked'}${duration === undefined ? '' : ` for ${formatElapsedDuration(duration)}`}`
	);
</script>

<div class="text-muted-foreground text-sm">
	<button
		type="button"
		class="text-muted-foreground hover:text-muted-foreground inline-flex items-center gap-1 transition"
		onclick={toggle}
		aria-expanded={disclosure.expanded}
	>
		<span>{label}</span>
		<ChevronRight
			class={`size-3.5 shrink-0 transition-transform ${disclosure.expanded ? 'rotate-90' : ''}`}
			aria-hidden="true"
		/>
	</button>
	{#if disclosure.expanded}
		<div class="mt-1.5 space-y-2">
			{#if loadError}<p role="status">Could not load details. Close and reopen to retry.</p>{/if}
			{@render children()}
		</div>
	{/if}
</div>
