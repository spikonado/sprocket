<script lang="ts">
	import { tick, untrack } from 'svelte';
	import type {
		TranscriptDisplayDetails,
		TranscriptDisplayRow,
		TranscriptDetailCursor
	} from '$lib/types/sprocket';
	import {
		buildAssistantTimeline,
		buildCommandSessionCommandMap,
		buildOpenExecCommandSessions,
		partitionWorkSectionTools,
		groupAssistantTimeline
	} from '$lib/chat/assistant-timeline';
	import { WorkDetails } from '$lib/project/work-details';
	import { TranscriptSectionKeys } from '$lib/chat/transcript-section-keys';
	import ReasoningDisclosure from './reasoning-disclosure.svelte';
	import WorkTools from './work-tools.svelte';

	let {
		row,
		load,
		inProgress,
		viewport,
		beforeChange
	}: {
		row: TranscriptDisplayRow;
		load: (
			row: TranscriptDisplayRow,
			cursor: TranscriptDetailCursor,
			signal: AbortSignal
		) => Promise<TranscriptDisplayDetails>;
		inProgress: boolean;
		viewport: HTMLDivElement | null;
		beforeChange: (follow: boolean) => () => void;
	} = $props();
	let version = $state(0);
	let container = $state<HTMLDivElement>();
	let top = $state<HTMLDivElement>();
	let bottom = $state<HTMLDivElement>();
	let lastTop = 0;
	let direction: 'older' | 'newer' = 'newer';
	const stalledPages = { older: 0, newer: 0 };
	const PREFETCH_VIEWPORTS = 3;
	const MAX_STALLED_PREFETCH_PAGES = 2;

	function distanceFromViewport(edge: HTMLDivElement | undefined) {
		if (!viewport || !edge) return Number.POSITIVE_INFINITY;
		const bounds = viewport.getBoundingClientRect();
		const target = edge.getBoundingClientRect();
		if (target.bottom < bounds.top) return bounds.top - target.bottom;
		if (target.top > bounds.bottom) return target.top - bounds.bottom;
		return 0;
	}

	const history = new WorkDetails(
		(cursor, signal) => load(row, cursor, signal),
		() => {
			version += 1;
		},
		async (update, edge) => {
			const previousDistance = edge
				? distanceFromViewport(edge === 'older' ? top : bottom)
				: undefined;
			const restore = beforeChange(inProgress && edge !== 'older');
			update();
			await tick();
			restore();
			lastTop = viewport?.scrollTop ?? 0;
			if (edge && previousDistance !== undefined) {
				const nextDistance = distanceFromViewport(edge === 'older' ? top : bottom);
				stalledPages[edge] = nextDistance <= previousDistance + 1 ? stalledPages[edge] + 1 : 0;
			}
		}
	);
	const details = $derived.by(() => {
		void version;
		return {
			parts: history.parts,
			loading: history.loading,
			indexing: history.indexing,
			error: history.error,
			stale: history.stale,
			previousBefore: history.previousBefore,
			nextAfter: history.nextAfter
		};
	});
	const timeline = $derived(buildAssistantTimeline(details.parts, []));
	const tools = $derived(timeline.filter((item) => item.type === 'tool'));
	const grouped = $derived(
		groupAssistantTimeline(timeline).filter((block) => block.type !== 'text')
	);
	const partitioned = $derived(
		partitionWorkSectionTools(grouped, inProgress, buildOpenExecCommandSessions(tools, inProgress))
	);
	const commands = $derived(buildCommandSessionCommandMap(tools));
	const blockKeys = new TranscriptSectionKeys();
	const settled = $derived(blockKeys.reconcileBlocks(row.id, partitioned.settledBlocks));

	function prefetchNearbyDetails() {
		if (
			!viewport ||
			viewport.clientHeight <= 0 ||
			history.loading ||
			history.error ||
			history.indexing
		)
			return;
		const directions: Array<'older' | 'newer'> =
			direction === 'older' ? ['older', 'newer'] : ['newer', 'older'];
		for (const next of directions) {
			const cursor = next === 'older' ? history.previousBefore : history.nextAfter;
			if (cursor === undefined || stalledPages[next] >= MAX_STALLED_PREFETCH_PAGES) continue;
			const edge = next === 'older' ? top : bottom;
			if (distanceFromViewport(edge) > viewport.clientHeight * PREFETCH_VIEWPORTS) continue;
			void history.more(next);
			return;
		}
	}

	$effect(() => {
		void row.revision;
		if (inProgress) stalledPages.newer = 0;
		untrack(() => void history.refresh());
	});
	$effect(() => () => history.stop());
	$effect(() => {
		void version;
		untrack(prefetchNearbyDetails);
	});
	$effect(() => {
		const root = viewport;
		if (!root || !top || !bottom) return;
		lastTop = root.scrollTop;
		function scroll() {
			if (!root || root.scrollTop === lastTop) return;
			const next = root.scrollTop < lastTop ? 'older' : 'newer';
			lastTop = root.scrollTop;
			direction = next;
			stalledPages[next] = 0;
			prefetchNearbyDetails();
		}
		const observer = globalThis.IntersectionObserver
			? new IntersectionObserver(prefetchNearbyDetails, {
					root,
					rootMargin: `${root.clientHeight * PREFETCH_VIEWPORTS}px 0px`
				})
			: undefined;
		const resizeObserver = globalThis.ResizeObserver
			? new ResizeObserver(() => {
					stalledPages.older = 0;
					stalledPages.newer = 0;
					prefetchNearbyDetails();
				})
			: undefined;
		observer?.observe(top);
		observer?.observe(bottom);
		if (container) resizeObserver?.observe(container);
		resizeObserver?.observe(root);
		root.addEventListener('scroll', scroll);
		return () => {
			observer?.disconnect();
			resizeObserver?.disconnect();
			root.removeEventListener('scroll', scroll);
		};
	});
</script>

<div bind:this={container} aria-busy={details.loading || details.indexing}>
	<div bind:this={top} data-work-edge="older" class="h-px" aria-hidden="true"></div>
	{#if details.stale}<p role="status">Showing saved details while reconnecting.</p>{/if}
	<div class="space-y-2">
		{#each settled as { block, renderKey } (renderKey)}
			<div data-work-detail>
				{#if block.type === 'reasoning'}
					<ReasoningDisclosure text={block.text} inProgress={false} />
				{:else if block.type === 'tool-group'}
					<WorkTools
						tools={block.tools}
						toolKey={block.toolKey}
						preserveExpansion={true}
						{inProgress}
						{commands}
					/>
				{/if}
			</div>
		{/each}
		{#if partitioned.runningTools.length}
			<div data-work-detail>
				<WorkTools tools={partitioned.runningTools} running={true} {inProgress} {commands} />
			</div>
		{/if}
	</div>
	{#if details.error}
		<p role="status">
			Could not load these details. <button
				class="underline"
				onclick={() => {
					stalledPages.older = 0;
					stalledPages.newer = 0;
					void history.retryFailed();
				}}>Retry</button
			>
		</p>
	{:else if (details.loading || details.indexing) && details.parts.length === 0}
		<p role="status">Loading details...</p>
	{/if}
	<div bind:this={bottom} data-work-edge="newer" class="h-px" aria-hidden="true"></div>
</div>
