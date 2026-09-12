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
	let top = $state<HTMLDivElement>();
	let bottom = $state<HTMLDivElement>();
	let lastTop = 0;
	let automaticPages = 2;
	let direction: 'older' | 'newer' = 'newer';
	const history = new WorkDetails(
		untrack(() => inProgress),
		(cursor, signal) => load(row, cursor, signal),
		() => {
			version += 1;
		},
		async (update, edge) => {
			const restore = beforeChange(inProgress && edge !== 'older');
			update();
			await tick();
			restore();
			lastTop = viewport?.scrollTop ?? 0;
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

	function loadVisible() {
		if (
			!viewport ||
			viewport.clientHeight <= 0 ||
			automaticPages <= 0 ||
			history.loading ||
			history.error ||
			history.indexing
		)
			return;
		const edge = direction === 'older' ? top : bottom;
		const cursor = direction === 'older' ? history.previousBefore : history.nextAfter;
		if (!edge || cursor === undefined) return;
		const bounds = viewport.getBoundingClientRect();
		const target = edge.getBoundingClientRect();
		if (target.bottom < bounds.top - 160 || target.top > bounds.bottom + 160) return;
		automaticPages -= 1;
		void history.more(direction);
	}

	$effect(() => {
		void row.revision;
		if (inProgress && direction === 'newer') automaticPages = 2;
		untrack(() => void history.refresh());
	});
	$effect(() => () => history.stop());
	$effect(() => {
		void version;
		untrack(loadVisible);
	});
	$effect(() => {
		const root = viewport;
		if (!root || !top || !bottom) return;
		lastTop = root.scrollTop;
		function intent(next: 'older' | 'newer') {
			direction = next;
			automaticPages = 2;
			loadVisible();
		}
		function scroll() {
			if (!root || root.scrollTop === lastTop) return;
			const next = root.scrollTop < lastTop ? 'older' : 'newer';
			lastTop = root.scrollTop;
			intent(next);
		}
		function wheel(event: WheelEvent) {
			if (event.deltaY) intent(event.deltaY < 0 ? 'older' : 'newer');
		}
		function key(event: KeyboardEvent) {
			if (
				event.target instanceof Element &&
				event.target.closest('input, textarea, button, [contenteditable="true"]')
			)
				return;
			if (
				['ArrowUp', 'PageUp', 'Home'].includes(event.key) ||
				(event.key === ' ' && event.shiftKey)
			)
				intent('older');
			if (
				['ArrowDown', 'PageDown', 'End'].includes(event.key) ||
				(event.key === ' ' && !event.shiftKey)
			)
				intent('newer');
		}
		let touchY: number | undefined;
		function touch(event: TouchEvent) {
			const y = event.touches[0]?.clientY;
			if (event.type === 'touchmove' && y !== undefined && touchY !== undefined && y !== touchY)
				intent(y > touchY ? 'older' : 'newer');
			touchY = y;
		}
		const observer = globalThis.IntersectionObserver
			? new IntersectionObserver(loadVisible, { root, rootMargin: '160px 0px' })
			: undefined;
		observer?.observe(top);
		observer?.observe(bottom);
		root.addEventListener('scroll', scroll);
		root.addEventListener('wheel', wheel, { passive: true });
		root.addEventListener('keydown', key);
		root.addEventListener('touchstart', touch, { passive: true });
		root.addEventListener('touchmove', touch, { passive: true });
		return () => {
			observer?.disconnect();
			root.removeEventListener('scroll', scroll);
			root.removeEventListener('wheel', wheel);
			root.removeEventListener('keydown', key);
			root.removeEventListener('touchstart', touch);
			root.removeEventListener('touchmove', touch);
		};
	});
</script>

<div aria-busy={details.loading || details.indexing}>
	<div bind:this={top} data-work-edge="older" class="h-px" aria-hidden="true"></div>
	{#if details.previousBefore !== undefined}<p class="text-xs">Scroll up for earlier work.</p>{/if}
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
					automaticPages = 2;
					void history.retryFailed();
				}}>Retry</button
			>
		</p>
	{:else if details.loading || details.indexing}
		<p role="status">Loading details...</p>
	{:else if details.nextAfter !== undefined}
		<p class="text-xs">Scroll down for more work.</p>
	{/if}
	<div bind:this={bottom} data-work-edge="newer" class="h-px" aria-hidden="true"></div>
</div>
