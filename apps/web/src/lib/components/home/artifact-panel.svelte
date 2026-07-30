<script lang="ts">
	import { FileCode, FileText, Globe, Maximize2, X } from '@lucide/svelte';
	import ArtifactDisplay from '$lib/components/home/artifact-display.svelte';
	import type { ArtifactEntry } from '$lib/chat/artifacts';
	import type { ArtifactType } from '$convex/lib/validators';

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

	const TYPE_ICONS: Record<ArtifactType, typeof FileCode> = {
		markdown: FileText,
		html: Globe,
		react: FileCode
	};
</script>

<aside class="flex h-screen min-h-0 w-full flex-col border-l">
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
		<div class="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
			{#each artifacts as artifact (artifact.key)}
				{@const TypeIcon = TYPE_ICONS[artifact.artifactType]}
				<div
					class="group hover:bg-muted flex items-center gap-2 rounded-md px-2 py-1.5 {selectedKey ===
					artifact.key
						? 'bg-muted'
						: ''}"
				>
					<button
						type="button"
						class="flex min-w-0 flex-1 items-center gap-2 text-left"
						onclick={() => onSelect(artifact.key)}
					>
						<TypeIcon class="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
						<span class="text-foreground min-w-0 truncate text-sm">{artifact.title}</span>
					</button>
					<button
						type="button"
						class="text-muted-foreground hover:text-foreground shrink-0 opacity-0 transition group-hover:opacity-100"
						onclick={() => onExpand(artifact.key)}
						aria-label={`Open ${artifact.title} fullscreen`}
					>
						<Maximize2 class="size-3.5" aria-hidden="true" />
					</button>
				</div>
			{:else}
				<p class="text-muted-foreground p-3 text-sm">No artifacts yet.</p>
			{/each}
		</div>
	{/if}
</aside>
