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
		loadAttachment?: (storageId: MessageAttachment['storageId']) => Promise<string | null>;
		onCopy: () => void;
		onOpenImage: (image: ViewerImage) => void;
	};

	let { message, copied, loadAttachment, onCopy, onOpenImage }: Props = $props();

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
</div>
