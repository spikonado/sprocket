<script lang="ts">
	import { FileText } from '@lucide/svelte';
	import { untrack } from 'svelte';
	import {
		isPreviewableImageMediaType,
		revokeAttachmentPreview,
		shouldEagerLoadAttachmentPreview,
		triggerAttachmentDownload
	} from '$lib/chat/attachments';
	import type { ViewerImage } from '$lib/components/image-viewer.svelte';
	import type { MessageAttachment } from '$lib/types/sprocket';

	type Props = {
		attachment: MessageAttachment;
		loadAttachment?: (imageUploadId: MessageAttachment['imageUploadId']) => Promise<string | null>;
		onOpen: (image: ViewerImage) => void;
	};

	let { attachment, loadAttachment, onOpen }: Props = $props();
	let ownedUrl = $state<string | null>(null);
	let loadFailed = $state(false);
	let downloadPending = $state(false);
	let downloadGeneration = 0;
	const url = $derived(ownedUrl ?? attachment.url);
	const previewable = $derived(isPreviewableImageMediaType(attachment.mediaType));
	const fileChipClass =
		'border-border hover:border-border focus-visible:ring-ring/40 text-foreground inline-flex h-14 max-w-56 items-center gap-2 rounded-xl border px-3 py-2 text-xs transition focus-visible:ring-2 focus-visible:outline-none';

	$effect(() => {
		const current = ownedUrl;
		return () => {
			revokeAttachmentPreview(current ?? undefined);
		};
	});

	$effect(() => {
		const imageUploadId = attachment.imageUploadId;
		const mediaType = attachment.mediaType;
		const existingUrl = attachment.url;
		if (!shouldEagerLoadAttachmentPreview({ mediaType, url: existingUrl })) {
			return;
		}
		const loader = untrack(() => loadAttachment);
		if (!loader) {
			return;
		}
		let cancelled = false;
		loadFailed = false;
		void loader(imageUploadId)
			.then((next) => {
				if (cancelled) {
					revokeAttachmentPreview(next ?? undefined);
					return;
				}
				ownedUrl = next;
				loadFailed = next == null;
			})
			.catch(() => {
				if (!cancelled) {
					loadFailed = true;
				}
			});
		return () => {
			cancelled = true;
		};
	});

	$effect(() => {
		return () => {
			downloadGeneration += 1;
		};
	});

	async function downloadFile() {
		if (downloadPending) {
			return;
		}
		const existing = url;
		if (existing?.startsWith('blob:')) {
			triggerAttachmentDownload(existing, attachment.name);
			return;
		}
		if (!loadAttachment && !existing) {
			loadFailed = true;
			return;
		}
		const generation = downloadGeneration;
		downloadPending = true;
		loadFailed = false;
		try {
			let next: string | null = null;
			if (loadAttachment) {
				next = await loadAttachment(attachment.imageUploadId);
			} else if (existing) {
				const response = await fetch(existing);
				if (!response.ok) throw new Error('Download failed');
				next = URL.createObjectURL(await response.blob());
			}
			if (generation !== downloadGeneration) {
				revokeAttachmentPreview(next ?? undefined);
				return;
			}
			if (!next) {
				loadFailed = true;
				return;
			}
			ownedUrl = next;
			triggerAttachmentDownload(next, attachment.name);
		} catch {
			if (generation === downloadGeneration) {
				loadFailed = true;
			}
		} finally {
			if (generation === downloadGeneration) {
				downloadPending = false;
			}
		}
	}
</script>

{#if url && previewable}
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
{:else if previewable && loadAttachment && !loadFailed}
	<span
		class="border-hairline bg-hover-fill inline-flex size-14 animate-pulse rounded-xl border"
		aria-label="Loading {attachment.name}"
	></span>
{:else if previewable}
	<span
		class="text-muted-foreground border-hairline bg-hover-fill inline-flex items-center rounded-xl border px-3 py-2 text-xs"
	>
		{attachment.name} (unavailable)
	</span>
{:else if downloadPending}
	<span
		class={`${fileChipClass} pointer-events-none animate-pulse`}
		aria-label="Downloading {attachment.name}"
		role="status"
	>
		<FileText class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
		<span class="min-w-0 truncate">{attachment.name}</span>
	</span>
{:else if loadFailed}
	<button
		type="button"
		class={`${fileChipClass} cursor-pointer`}
		aria-label="Retry download of {attachment.name}"
		title={attachment.name}
		onclick={() => {
			void downloadFile();
		}}
	>
		<FileText class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
		<span class="min-w-0 truncate">{attachment.name} (unavailable)</span>
	</button>
{:else if loadAttachment || url}
	<button
		type="button"
		class={`${fileChipClass} cursor-pointer`}
		aria-label="Download {attachment.name}"
		title={attachment.name}
		onclick={() => {
			void downloadFile();
		}}
	>
		<FileText class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
		<span class="min-w-0 truncate">{attachment.name}</span>
	</button>
{:else}
	<span
		class="text-muted-foreground border-hairline bg-hover-fill inline-flex items-center rounded-xl border px-3 py-2 text-xs"
	>
		{attachment.name} (unavailable)
	</span>
{/if}
