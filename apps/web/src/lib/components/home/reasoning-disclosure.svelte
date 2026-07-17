<script lang="ts">
	import { Brain, ChevronRight } from '@lucide/svelte';

	type Props = {
		text: string;
		inProgress: boolean;
	};

	let { text, inProgress }: Props = $props();

	let manuallyExpanded = $state(false);
	let manuallyCollapsed = $state(false);

	$effect(() => {
		if (inProgress) {
			manuallyCollapsed = false;
		} else {
			manuallyExpanded = false;
		}
	});

	const expanded = $derived(inProgress ? !manuallyCollapsed : manuallyExpanded);
	const label = $derived(inProgress ? 'Reasoning' : 'Reasoned');

	function toggle() {
		if (inProgress) {
			manuallyCollapsed = !manuallyCollapsed;
		} else {
			manuallyExpanded = !manuallyExpanded;
		}
	}
</script>

<div class="text-sm text-slate-500">
	<button
		type="button"
		class="inline-flex items-center gap-1.5 text-slate-500 transition hover:text-slate-300"
		onclick={toggle}
		aria-expanded={expanded}
	>
		<Brain class="size-3.5 shrink-0" aria-hidden="true" />
		<span>{label}</span>
		<ChevronRight
			class={`size-3.5 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
			aria-hidden="true"
		/>
	</button>
	{#if expanded}
		<div class="mt-1.5 whitespace-pre-wrap text-[13px] leading-6 text-slate-400">
			{text}
		</div>
	{/if}
</div>
