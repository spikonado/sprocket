<script lang="ts">
	import { untrack } from 'svelte';
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
	import ReasoningDisclosure from './reasoning-disclosure.svelte';
	import WorkTools from './work-tools.svelte';

	let {
		row,
		load,
		inProgress
	}: {
		row: TranscriptDisplayRow;
		load: (
			row: TranscriptDisplayRow,
			cursor: TranscriptDetailCursor,
			signal: AbortSignal
		) => Promise<TranscriptDisplayDetails>;
		inProgress: boolean;
	} = $props();
	let page = $state.raw<TranscriptDisplayDetails | null>(null);
	let loading = $state(false);
	let error = $state(false);
	let cursor = $state.raw<TranscriptDetailCursor | undefined>();
	let pageKey = $state(0);
	let shownCursor: TranscriptDetailCursor | undefined;
	let request: AbortController | undefined;
	let retry: ReturnType<typeof setTimeout> | undefined;
	const timeline = $derived(buildAssistantTimeline(page?.parts ?? [], []));
	const tools = $derived(timeline.filter((item) => item.type === 'tool'));
	const grouped = $derived(
		groupAssistantTimeline(timeline).filter((block) => block.type !== 'text')
	);
	const partitioned = $derived(
		partitionWorkSectionTools(grouped, inProgress, buildOpenExecCommandSessions(tools, inProgress))
	);
	const commands = $derived(buildCommandSessionCommandMap(tools));

	async function fetchPage(nextCursor: TranscriptDetailCursor) {
		const changingPage = JSON.stringify(shownCursor) !== JSON.stringify(nextCursor);
		cursor = nextCursor;
		clearTimeout(retry);
		request?.abort();
		const controller = new AbortController();
		request = controller;
		loading = true;
		error = false;
		try {
			const next = await load(row, nextCursor, controller.signal);
			if (controller.signal.aborted) return;
			if (next.indexing) {
				retry = setTimeout(() => void fetchPage(nextCursor), 500);
				return;
			}
			page = next;
			shownCursor = nextCursor;
			if (changingPage) pageKey += 1;
			if (next.stale) retry = setTimeout(() => void fetchPage(nextCursor), 2_000);
		} catch {
			if (!controller.signal.aborted) error = true;
		} finally {
			if (!controller.signal.aborted) loading = false;
		}
	}

	$effect(() => {
		void row.revision;
		untrack(() => {
			void fetchPage(cursor ?? (inProgress ? { latest: true } : {}));
		});
		return () => {
			request?.abort();
			clearTimeout(retry);
		};
	});
</script>

<div aria-busy={loading}>
	{#if error}
		<p role="status">
			Could not load these details. <button
				class="underline"
				onclick={() => fetchPage(cursor ?? {})}>Retry</button
			>
		</p>
	{:else if loading && !page}
		<p role="status">Loading details...</p>
	{/if}
	{#if page?.stale}<p role="status">Showing saved details while reconnecting.</p>{/if}
	<div class="space-y-2">
		{#each partitioned.settledBlocks as block, index (`${row.id}:${pageKey}:${index}`)}
			{#if block.type === 'reasoning'}
				<ReasoningDisclosure text={block.text} inProgress={false} />
			{:else if block.type === 'tool-group'}
				<WorkTools tools={block.tools} toolKey={block.toolKey} {inProgress} {commands} />
			{/if}
		{/each}
		{#if partitioned.runningTools.length}
			<WorkTools tools={partitioned.runningTools} running={true} {inProgress} {commands} />
		{/if}
	</div>
	{#if page?.previousBefore !== undefined || page?.nextAfter !== undefined}
		<nav aria-label="Work section details" class="mt-3 flex gap-4 text-sm">
			<button
				disabled={loading || page?.previousBefore === undefined}
				class="underline disabled:opacity-40"
				onclick={() => {
					const before = page?.previousBefore;
					if (before !== undefined) void fetchPage({ before });
				}}>Previous details</button
			>
			<button
				disabled={loading || page?.nextAfter === undefined}
				class="underline disabled:opacity-40"
				onclick={() => {
					const after = page?.nextAfter;
					if (after !== undefined) void fetchPage({ after });
				}}>Next details</button
			>
		</nav>
	{/if}
</div>
