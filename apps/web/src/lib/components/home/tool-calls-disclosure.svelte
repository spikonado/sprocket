<script lang="ts">
	import { ChevronRight } from '@lucide/svelte';
	import type { Snippet } from 'svelte';
	import type { AssistantTimelineTool } from '$lib/chat/assistant-timeline';

	type Props = {
		label: string;
		tools: AssistantTimelineTool[];
		/** When set, overrides the default open-when-≤2 rule. */
		defaultExpanded?: boolean;
		toolRow: Snippet<[AssistantTimelineTool]>;
	};

	let { label, tools, defaultExpanded, toolRow }: Props = $props();

	let manual = $state<boolean | null>(null);

	const expanded = $derived(manual ?? defaultExpanded ?? tools.length <= 2);

	function toggle() {
		manual = !expanded;
	}
</script>

<div class="text-sm text-slate-500">
	<button
		type="button"
		class="inline-flex items-center gap-1 text-slate-500 transition hover:text-slate-300"
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
		<div class="mt-1.5 space-y-1.5 text-[13px] leading-6 text-slate-400">
			{#each tools as tool (tool.callId)}
				{@render toolRow(tool)}
			{/each}
		</div>
	{/if}
</div>
