<script lang="ts">
	import { Check, Copy } from '@lucide/svelte';
	import ChatMarkdown from '$lib/components/chat-markdown.svelte';
	import TranscriptAttachment from '$lib/components/home/transcript-attachment.svelte';
	import type { ViewerImage } from '$lib/components/image-viewer.svelte';
	import type { MessageAttachment, TranscriptDisplayRow } from '$lib/types/sprocket';

	type PromptMessage = Pick<TranscriptDisplayRow, 'id' | 'text' | 'attachments'>;
	type Props = {
		message: PromptMessage;
		copied: boolean;
		remoteChangeNotice: string | null;
		onDismissRemoteChangeNotice?: () => void;
		loadAttachment?: (storageId: MessageAttachment['storageId']) => Promise<string | null>;
		onCopy: () => void;
		onOpenImage: (image: ViewerImage) => void;
	};

	let {
		message,
		copied,
		remoteChangeNotice,
		onDismissRemoteChangeNotice,
		loadAttachment,
		onCopy,
		onOpenImage
	}: Props = $props();

	const userMessageClass =
		'user-bubble w-fit max-w-[33rem] rounded-xl border px-5 py-3.5 text-[15.5px] leading-7 text-foreground';
</script>

<div
	data-message-id={message.id}
	data-transcript-anchor={message.id}
	class="flex flex-col items-end gap-1.5"
>
	{#if (message.attachments ?? []).length}
		<ul class="flex max-w-132 flex-wrap justify-end gap-2" aria-label="Attached files">
			{#each message.attachments ?? [] as attachment (attachment.storageId)}
				<li>
					<TranscriptAttachment
						attachment={{ ...attachment, url: null }}
						{loadAttachment}
						onOpen={onOpenImage}
					/>
				</li>
			{/each}
		</ul>
	{/if}
	{#if message.text || !(message.attachments ?? []).length}
		<div class={userMessageClass}>
			<ChatMarkdown content={message.text || ' '} className="text-foreground" />
		</div>
	{/if}
	{#if message.text}
		<button
			type="button"
			class="text-muted-foreground hover:text-muted-foreground inline-flex size-6 items-center justify-center rounded-md transition"
			aria-label={copied ? 'Copied' : 'Copy message'}
			onclick={onCopy}
		>
			{#if copied}
				<Check class="size-3.5" aria-hidden="true" />
			{:else}
				<Copy class="size-3.5" aria-hidden="true" />
			{/if}
		</button>
	{/if}
	{#if remoteChangeNotice}
		<div
			role="status"
			class="w-full max-w-132 rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-left text-sm text-amber-800 dark:text-amber-200"
		>
			<div class="flex items-start justify-between gap-3">
				<p class="min-w-0 flex-1 leading-6">{remoteChangeNotice}</p>
				{#if onDismissRemoteChangeNotice}
					<button
						type="button"
						class="shrink-0 text-xs font-medium tracking-[-0.01em] text-amber-800/80 underline-offset-2 hover:text-amber-900 hover:underline dark:text-amber-200/80 dark:hover:text-amber-100"
						onclick={onDismissRemoteChangeNotice}
					>
						Dismiss
					</button>
				{/if}
			</div>
		</div>
	{/if}
</div>
