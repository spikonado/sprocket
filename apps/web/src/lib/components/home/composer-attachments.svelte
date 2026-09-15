<script lang="ts">
	import { FileText, X } from '@lucide/svelte';
	import {
		formatAttachmentSize,
		isPreviewableImageMediaType,
		type ComposerAttachment
	} from '$lib/chat/attachments';

	type Props = {
		attachments: ComposerAttachment[];
		disabled: boolean;
		onRemove: (localId: string) => void;
	};

	let { attachments, disabled, onRemove }: Props = $props();
</script>

<ul
	class="mb-3 flex max-h-36 flex-wrap items-center gap-2 overflow-y-auto"
	aria-label="Attached files"
>
	{#each attachments as attachment (attachment.localId)}
		{@const previewable =
			isPreviewableImageMediaType(attachment.mediaType) && Boolean(attachment.previewUrl)}
		<li
			class={previewable
				? `group relative size-14 overflow-hidden rounded-xl border ${
						attachment.status === 'error' ? 'border-rose-500/60' : 'border-border'
					}`
				: `group relative flex h-14 max-w-56 items-center gap-2 overflow-hidden rounded-xl border pr-7 pl-2 ${
						attachment.status === 'error' ? 'border-rose-500/60' : 'border-border'
					}`}
			title={attachment.error ?? `${attachment.name} · ${formatAttachmentSize(attachment.size)}`}
		>
			{#if previewable}
				<img
					src={attachment.previewUrl}
					alt={attachment.name}
					class="size-full object-cover {attachment.status === 'uploading' ? 'opacity-50' : ''}"
				/>
			{:else}
				<FileText class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
				<span class="min-w-0 text-[12px] leading-4">
					<span class="text-foreground block truncate">{attachment.name}</span>
					<span class="text-muted-foreground block">{formatAttachmentSize(attachment.size)}</span>
				</span>
			{/if}
			{#if attachment.status === 'uploading'}
				<span
					class="absolute inset-0 flex items-center justify-center {previewable
						? ''
						: 'bg-background/60'}"
					role="status"
					aria-label="Uploading {attachment.name}"
				>
					<span
						class="border-border border-t-foreground/80 size-3.5 animate-spin rounded-full border-2"
					></span>
				</span>
			{:else if attachment.status === 'error'}
				<span
					class="text-destructive absolute inset-x-0 bottom-0 bg-rose-950/80 px-1 py-0.5 text-center text-[9px] leading-3"
					role="alert"
				>
					Failed
				</span>
			{/if}
			<button
				type="button"
				class="bg-foreground/70 text-background hover:bg-foreground/90 absolute top-1 right-1 flex size-4.5 cursor-pointer items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-40"
				aria-label="Remove {attachment.name}"
				{disabled}
				onclick={() => onRemove(attachment.localId)}
			>
				<X class="size-3" aria-hidden="true" />
			</button>
		</li>
	{/each}
</ul>
