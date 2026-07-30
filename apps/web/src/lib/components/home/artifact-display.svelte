<script lang="ts">
	import { ArrowLeft, Check, Code2, Copy, Eye, Maximize2 } from '@lucide/svelte';
	import ChatMarkdown from '$lib/components/chat-markdown.svelte';
	import type { ArtifactType } from '$convex/lib/validators';
	import { buildArtifactPreviewDocument } from '$lib/chat/artifact-preview';

	type Props = {
		title: string;
		artifactType: ArtifactType;
		content: string;
		variant?: 'card' | 'full';
		onExpand?: () => void;
		onBack?: () => void;
	};

	let { title, artifactType, content, variant = 'card', onExpand, onBack }: Props = $props();

	const previewDocument = $derived(buildArtifactPreviewDocument(artifactType, content));
	let showSource = $state(false);
	let copied = $state(false);
	let copyTimeout: ReturnType<typeof setTimeout> | null = null;

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

<div
	class={variant === 'full'
		? 'bg-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border'
		: 'bg-card rounded-lg border'}
>
	<div class="flex items-center gap-2 px-3 py-2">
		{#if onBack}
			<button
				type="button"
				class="text-muted-foreground hover:text-foreground shrink-0 transition"
				onclick={onBack}
				aria-label="Back to artifacts"
			>
				<ArrowLeft class="size-4" aria-hidden="true" />
			</button>
		{/if}
		<div class="flex min-w-0 flex-1 items-center gap-2">
			<span class="text-foreground min-w-0 truncate text-sm font-medium">{title}</span>
			<span class="text-muted-foreground shrink-0 text-[11px]">{artifactType}</span>
		</div>
		{#if previewDocument}
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
		{#if onExpand}
			<button
				type="button"
				class="text-muted-foreground hover:text-foreground shrink-0 transition"
				onclick={onExpand}
				aria-label="Open fullscreen"
			>
				<Maximize2 class="size-4" aria-hidden="true" />
			</button>
		{/if}
	</div>
	{#snippet body(frameClass: string)}
		<div class="relative min-h-0 flex-1 border-t">
			{#if previewDocument && !showSource}
				<iframe
					title={`${title} preview`}
					srcdoc={previewDocument}
					sandbox="allow-scripts"
					class={`block w-full bg-white ${frameClass}`}
				></iframe>
			{:else if previewDocument}
				<pre class="h-full overflow-auto p-3 pr-10 text-[13px] leading-6"><code>{content}</code
					></pre>
			{:else}
				<div class="h-full overflow-auto p-3 pr-10">
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
	{/snippet}
	{#if variant === 'full'}
		{@render body('h-full')}
	{:else}
		{@render body('h-64')}
	{/if}
</div>
