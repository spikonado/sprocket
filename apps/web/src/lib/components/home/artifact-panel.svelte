<script lang="ts">
	import { X } from '@lucide/svelte';
	import ArtifactDisplay from '$lib/components/home/artifact-display.svelte';
	import type { ArtifactEntry } from '$lib/chat/artifacts';

	type Props = {
		artifacts: ArtifactEntry[];
		selectedKey: string | null;
		onSelect: (key: string) => void;
		onBack: () => void;
		onExpand: (key: string) => void;
		onClose: () => void;
	};

	let { artifacts, selectedKey, onSelect, onBack, onExpand, onClose }: Props = $props();

	const selected = $derived(artifacts.find((artifact) => artifact.key === selectedKey) ?? null);
</script>

<aside class="flex h-screen w-[26rem] shrink-0 flex-col border-l">
	<div class="flex items-center gap-1 border-b px-2 py-1.5">
		<span
			class="bg-muted text-foreground rounded-md px-2.5 py-1 text-xs font-medium"
			aria-current="page"
		>
			Artifacts
		</span>
		<div class="flex-1"></div>
		<button
			type="button"
			class="text-muted-foreground hover:text-foreground transition"
			onclick={onClose}
			aria-label="Close panel"
		>
			<X class="size-4" aria-hidden="true" />
		</button>
	</div>
	{#if selected}
		<div class="flex min-h-0 flex-1 flex-col p-3">
			<ArtifactDisplay
				title={selected.title}
				artifactType={selected.artifactType}
				content={selected.content}
				variant="full"
				onExpand={() => onExpand(selected.key)}
				{onBack}
			/>
		</div>
	{:else}
		<div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
			{#each artifacts as artifact (artifact.key)}
				<button
					type="button"
					class="block w-full cursor-pointer text-left"
					onclick={() => onSelect(artifact.key)}
				>
					<ArtifactDisplay
						title={artifact.title}
						artifactType={artifact.artifactType}
						content={artifact.content}
						onExpand={() => onExpand(artifact.key)}
					/>
				</button>
			{:else}
				<p class="text-muted-foreground p-3 text-sm">No artifacts yet.</p>
			{/each}
		</div>
	{/if}
</aside>
