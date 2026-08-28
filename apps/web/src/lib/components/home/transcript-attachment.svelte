<script lang="ts">
	import type { ViewerImage } from '$lib/components/image-viewer.svelte';
	import type { MessageAttachment } from '$lib/types/sprocket';

	type Props = {
		attachment: MessageAttachment;
		loadAttachment?: (imageUploadId: MessageAttachment['imageUploadId']) => Promise<string | null>;
		onOpen: (image: ViewerImage) => void;
	};

	let { attachment, loadAttachment, onOpen }: Props = $props();
	let loadedUrl = $state<string | null>(null);
	let loadFailed = $state(false);
	const url = $derived(loadedUrl ?? attachment.url);

	$effect(() => {
		if (attachment.url || !loadAttachment) {
			return;
		}
		let cancelled = false;
		let objectUrl: string | null = null;
		void loadAttachment(attachment.imageUploadId)
			.then((next) => {
				if (cancelled) {
					if (next) {
						URL.revokeObjectURL(next);
					}
					return;
				}
				objectUrl = next;
				loadedUrl = next;
				loadFailed = next == null;
			})
			.catch(() => {
				if (!cancelled) {
					loadFailed = true;
				}
			});
		return () => {
			cancelled = true;
			if (objectUrl) {
				URL.revokeObjectURL(objectUrl);
			}
		};
	});
</script>

{#if url}
	<button
		type="button"
		class="border-border hover:border-border focus-visible:ring-ring/40 block size-14 cursor-zoom-in overflow-hidden rounded-xl border transition focus-visible:ring-2 focus-visible:outline-none"
		aria-label="View {attachment.name}"
		title={attachment.name}
		onclick={() => {
			if (!url) {
				return;
			}
			onOpen({
				url,
				name: attachment.name,
				mediaType: attachment.mediaType
			});
		}}
	>
		<img src={url} alt="" loading="lazy" class="size-full object-cover" />
	</button>
{:else if loadAttachment && !loadFailed}
	<span
		class="border-hairline bg-hover-fill inline-flex size-14 animate-pulse rounded-xl border"
		aria-label="Loading {attachment.name}"
	></span>
{:else}
	<span
		class="text-muted-foreground border-hairline bg-hover-fill inline-flex items-center rounded-xl border px-3 py-2 text-xs"
	>
		{attachment.name} (unavailable)
	</span>
{/if}
