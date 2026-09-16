<script lang="ts">
	import { FileCode, FileText, Globe } from '@lucide/svelte';
	import type { ArtifactEntry } from '$lib/chat/artifacts';

	type Props = {
		artifact: ArtifactEntry;
		onOpen: () => void;
	};

	let { artifact, onOpen }: Props = $props();

	const TYPE_ICONS = {
		markdown: FileText,
		html: Globe,
		react: FileCode
	} as const;
	const TypeIcon = $derived(TYPE_ICONS[artifact.artifactType]);
</script>

<div
	data-artifact-reference={artifact.key}
	class="bg-card my-3 flex min-w-0 items-center gap-3 rounded-lg border p-3 shadow-xs"
>
	<div class="bg-muted flex size-10 shrink-0 items-center justify-center rounded-md border">
		<TypeIcon class="text-muted-foreground size-4" aria-hidden="true" />
	</div>
	<div class="min-w-0 flex-1">
		<div class="text-foreground truncate text-sm font-medium">{artifact.title}</div>
		<div class="text-muted-foreground mt-0.5 text-xs">
			Artifact · {artifact.scope === 'project' ? 'Project' : 'Thread'}
		</div>
	</div>
	<button
		type="button"
		class="bg-background text-foreground hover:bg-muted shrink-0 rounded-md border px-3 py-1.5 text-sm font-medium transition"
		onclick={onOpen}
		aria-label={`View ${artifact.title}`}
	>
		View
	</button>
</div>
