<script lang="ts">
	import { ChevronRight, type LucideIcon } from '@lucide/svelte';
	import type { Snippet } from 'svelte';
	import type { AssistantTimelineTool } from '$lib/chat/assistant-timeline';

	type Props = {
		label: string;
		icon: LucideIcon;
		/** Extra classes for the leading icon (e.g. animate-spin). */
		iconClass?: string;
		tools: AssistantTimelineTool[];
		/** When set, overrides the default open-when-≤2 rule. */
		defaultExpanded?: boolean;
		toolRow: Snippet<[AssistantTimelineTool]>;
	};

	let { label, icon: Icon, iconClass, tools, defaultExpanded, toolRow }: Props = $props();

	let manual = $state<boolean | null>(null);

	const expanded = $derived(manual ?? defaultExpanded ?? tools.length <= 2);

	function toggle() {
		manual = !expanded;
	}
</script>

<div class="text-muted-foreground text-sm">
	<button
		type="button"
		class="text-muted-foreground hover:text-muted-foreground inline-flex items-center gap-1.5 transition"
		onclick={toggle}
		aria-expanded={expanded}
	>
		<Icon class={`size-3.5 shrink-0 ${iconClass ?? ''}`} aria-hidden="true" />
		<span>{label}</span>
		<ChevronRight
			class={`size-3.5 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
			aria-hidden="true"
		/>
	</button>
	{#if expanded}
		<div class="text-muted-foreground mt-1.5 space-y-1.5 text-[13px] leading-6">
			{#each tools as tool (tool.callId)}
				{@render toolRow(tool)}
			{/each}
		</div>
	{/if}
</div>
