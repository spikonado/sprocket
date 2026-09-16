<script lang="ts">
	import type { SkillSummary } from '$lib/types/sprocket';

	type Props = {
		loadState: 'idle' | 'loading' | 'ready' | 'error';
		skills: SkillSummary[];
		highlightedIndex: number;
		onRetry: () => void;
		onHighlight: (index: number) => void;
		onSelect: (skill: SkillSummary) => void;
	};

	let { loadState, skills, highlightedIndex, onRetry, onHighlight, onSelect }: Props = $props();
	let optionElements = $state<Array<HTMLElement | null>>([]);

	$effect(() => {
		if (skills.length > 0) optionElements[highlightedIndex]?.scrollIntoView({ block: 'nearest' });
	});
</script>

<div
	class="border-border bg-popover absolute inset-x-0 bottom-full z-30 mb-2 max-h-56 overflow-y-auto rounded-xl border py-1 shadow-2xl"
	id="composer-skills-listbox"
	aria-label="Available skills"
	role={loadState === 'ready' && skills.length > 0 ? 'listbox' : 'status'}
>
	{#if loadState === 'loading'}
		<p class="text-muted-foreground px-3 py-2 text-sm">Loading skills…</p>
	{:else if loadState === 'error'}
		<div class="flex items-center justify-between gap-3 px-3 py-2">
			<p class="text-muted-foreground text-sm">Couldn’t load skills</p>
			<button
				type="button"
				class="text-muted-foreground hover:text-foreground text-sm underline-offset-2 hover:underline"
				onclick={onRetry}
			>
				Retry
			</button>
		</div>
	{:else if skills.length === 0}
		<p class="text-muted-foreground px-3 py-2 text-sm">No matching skills</p>
	{:else}
		{#each skills as skill, index (skill.name)}
			<button
				type="button"
				bind:this={optionElements[index]}
				id="composer-skill-option-{index}"
				class={`flex w-full flex-col gap-0.5 px-3 py-2 text-left transition ${
					highlightedIndex === index
						? 'text-foreground bg-hover-fill-strong'
						: 'text-muted-foreground hover:text-foreground hover:bg-hover-fill'
				}`}
				role="option"
				aria-selected={highlightedIndex === index}
				onpointerenter={() => onHighlight(index)}
				onclick={() => onSelect(skill)}
			>
				<span class="text-sm font-medium">${skill.name}</span>
				<span class="text-muted-foreground line-clamp-2 text-[12px]">{skill.description}</span>
			</button>
		{/each}
	{/if}
</div>
