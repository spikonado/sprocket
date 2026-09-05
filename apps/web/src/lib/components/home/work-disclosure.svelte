<script lang="ts">
	import { ChevronRight } from '@lucide/svelte';
	import { untrack, type Snippet } from 'svelte';
	import { createInProgressDisclosure } from '$lib/components/home/in-progress-disclosure.svelte';
	import { formatElapsedDuration } from '$lib/format';

	type Props = {
		inProgress: boolean;
		/** Durable Convex/job/run wall-clock start for this work section. */
		startedAtMs: number;
		/** Durable end when the section is finished; omit while in progress. */
		completedAtMs?: number;
		children: Snippet;
		onExpand?: () => void | Promise<void>;
		detailsKey?: string;
	};

	let { inProgress, startedAtMs, completedAtMs, children, onExpand, detailsKey }: Props = $props();
	let loading = $state(false);
	let loadError = $state(false);

	function toggle() {
		disclosure.toggle();
	}

	let elapsedSeconds = $state(0);
	const disclosure = createInProgressDisclosure(() => inProgress);

	$effect(() => {
		void detailsKey;
		if (!disclosure.expanded) return;
		let cancelled = false;
		loading = true;
		loadError = false;
		void Promise.resolve(untrack(() => onExpand?.()))
			.catch(() => {
				if (!cancelled) loadError = true;
			})
			.finally(() => {
				if (!cancelled) loading = false;
			});
		return () => {
			cancelled = true;
		};
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

	const label = $derived(
		inProgress
			? `Working for ${formatElapsedDuration(elapsedSeconds)}`
			: `Worked for ${formatElapsedDuration(elapsedSeconds)}`
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
			{#if loading}<p role="status">Loading details…</p>{/if}
			{#if loadError}<p role="status">Could not load details. Close and reopen to retry.</p>{/if}
			{@render children()}
		</div>
	{/if}
</div>
