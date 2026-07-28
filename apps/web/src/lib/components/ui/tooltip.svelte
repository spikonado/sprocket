<script lang="ts">
	import type { LockTooltipState } from '$lib/components/ui/lock-tooltip.svelte';

	let { tooltip }: { tooltip: LockTooltipState | null } = $props();
</script>

{#if tooltip}
	<div
		class="text-tooltip-foreground bg-tooltip ring-border pointer-events-none fixed z-100 -translate-x-1/2 -translate-y-full rounded-md px-2.5 py-1.5 text-[12px] leading-4 whitespace-nowrap shadow-lg ring-1"
		style={`top: ${tooltip.top}px; left: ${tooltip.left}px;`}
		role="tooltip"
	>
		{tooltip.label}
	</div>
{/if}
