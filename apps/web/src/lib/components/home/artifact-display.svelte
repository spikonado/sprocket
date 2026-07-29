<script lang="ts">
	import { ChevronRight, Copy, Check, Code2, Eye } from '@lucide/svelte';
	import ChatMarkdown from '$lib/components/chat-markdown.svelte';
	import type { ArtifactType } from '$convex/lib/validators';
	import { buildArtifactPreviewDocument } from '$lib/chat/artifact-preview';

	type Props = {
		title: string;
		artifactType: ArtifactType;
		content: string;
	};

	let { title, artifactType, content }: Props = $props();

	const previewDocument = $derived(buildArtifactPreviewDocument(artifactType, content));
	// svelte-ignore state_referenced_locally
	let expanded = $state(artifactType === 'react' || artifactType === 'html');
	let showSource = $state(false);
	let copied = $state(false);
	let copyTimeout: ReturnType<typeof setTimeout> | null = null;

	function toggle() {
		expanded = !expanded;
	}

	async function copyContent() {
		try {
			await navigator.clipboard.writeText(content);
			copied = true;
			if (copyTimeout !== null) {
				clearTimeout(copyTimeout);
			}
			copyTimeout = setTimeout(() => {
				copied = false;
				copyTimeout = null;
			}, 1_500);
		} catch {
			copied = false;
		}
	}

	$effect(() => {
		return () => {
			if (copyTimeout !== null) {
				clearTimeout(copyTimeout);
			}
		};
	});
</script>

<div class="bg-card rounded-lg border">
	<div class="flex items-center gap-2 px-3 py-2">
		<button
			type="button"
			class="text-muted-foreground hover:text-foreground flex min-w-0 flex-1 items-center gap-2 text-left text-sm transition"
			onclick={toggle}
			aria-expanded={expanded}
		>
			<ChevronRight
				class={`size-3.5 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
				aria-hidden="true"
			/>
			<span class="text-foreground min-w-0 truncate font-medium">{title}</span>
			<span class="text-muted-foreground shrink-0 text-[11px]">{artifactType}</span>
		</button>
		{#if previewDocument && expanded}
			<button
				type="button"
				class="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition"
				onclick={() => (showSource = !showSource)}
				aria-label={showSource ? 'Show preview' : 'Show source'}
			>
				{#if showSource}
					<Eye class="size-3.5" aria-hidden="true" />
					Preview
				{:else}
					<Code2 class="size-3.5" aria-hidden="true" />
					Source
				{/if}
			</button>
		{/if}
	</div>
	{#if expanded}
		<div class="relative border-t">
			{#if previewDocument && !showSource}
				<iframe
					title={`${title} preview`}
					srcdoc={previewDocument}
					sandbox="allow-scripts"
					class="block h-112 w-full bg-white"
				></iframe>
			{:else if previewDocument}
				<pre class="overflow-x-auto p-3 pr-10 text-[13px] leading-6"><code>{content}</code></pre>
			{:else}
				<div class="p-3 pr-10">
					<ChatMarkdown {content} className="text-sm text-foreground" />
				</div>
			{/if}
			<button
				type="button"
				class="bg-card text-muted-foreground hover:text-foreground absolute top-2 right-2 rounded-md border p-1 transition"
				aria-label={copied ? 'Copied' : 'Copy'}
				onclick={copyContent}
			>
				{#if copied}
					<Check class="size-3.5" aria-hidden="true" />
				{:else}
					<Copy class="size-3.5" aria-hidden="true" />
				{/if}
			</button>
		</div>
	{/if}
</div>
