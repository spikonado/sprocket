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

<div class="text-muted-foreground text-sm">
	<button
		type="button"
		class="text-muted-foreground hover:text-muted-foreground inline-flex items-center gap-1.5 transition"
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
		<div class="text-muted-foreground mt-1.5 text-[13px] leading-6 whitespace-pre-wrap">
			{text}
		</div>
	{/if}
</div>
