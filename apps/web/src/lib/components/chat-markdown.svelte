<script lang="ts">
	import { cn } from '$lib/utils';
	import type { ArtifactEntry } from '$lib/chat/artifacts';
	import { renderMarkdownBlocks } from '$lib/chat/markdown';
	import ArtifactReference from '$lib/components/artifact-reference.svelte';

	const NO_ARTIFACTS = new Set<string>();

	type Props = {
		content: string;
		className?: string;
		artifacts?: ArtifactEntry[];
		onOpenArtifact?: (artifactId: string) => void;
	};

	let { content, className = '', artifacts = [], onOpenArtifact }: Props = $props();

	const artifactById = $derived(new Map(artifacts.map((artifact) => [artifact.key, artifact])));
	const blocks = $derived(
		renderMarkdownBlocks(content, onOpenArtifact ? new Set(artifactById.keys()) : NO_ARTIFACTS)
	);
</script>

<div class={cn('chat-markdown', className)}>
	{#each blocks as block, index (`${block.type}-${index}`)}
		{#if block.type === 'artifact'}
			{@const artifact = artifactById.get(block.artifactId)}
			{#if artifact && onOpenArtifact}
				<ArtifactReference {artifact} onOpen={() => onOpenArtifact(block.artifactId)} />
			{/if}
		{:else}
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			{@html block.html}
		{/if}
	{/each}
</div>
