<script lang="ts">
	import { Brain, ChevronRight } from '@lucide/svelte';
	import { createInProgressDisclosure } from '$lib/components/home/in-progress-disclosure.svelte';

	type Props = {
		text: string;
		inProgress: boolean;
	};

	let { text, inProgress }: Props = $props();

	const disclosure = createInProgressDisclosure(() => inProgress);
	const label = $derived(inProgress ? 'Reasoning' : 'Reasoned');
</script>

<div class="text-muted-foreground text-sm">
	<button
		type="button"
		class="text-muted-foreground hover:text-muted-foreground inline-flex items-center gap-1.5 transition"
		onclick={disclosure.toggle}
		aria-expanded={disclosure.expanded}
	>
		<Brain class="size-3.5 shrink-0" aria-hidden="true" />
		<span>{label}</span>
		<ChevronRight
			class={`size-3.5 shrink-0 transition-transform ${disclosure.expanded ? 'rotate-90' : ''}`}
			aria-hidden="true"
		/>
	</button>
	{#if disclosure.expanded}
		<div class="text-muted-foreground mt-1.5 text-[13px] leading-6 whitespace-pre-wrap">
			{text}
		</div>
	{/if}
</div>
