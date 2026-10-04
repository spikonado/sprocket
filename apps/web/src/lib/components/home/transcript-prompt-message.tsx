import { Check, Copy } from 'lucide-react';
import ChatMarkdown from '$lib/components/chat-markdown';
import TranscriptAttachment from '$lib/components/home/transcript-attachment';
import type { ViewerImage } from '$lib/components/image-viewer';
import type { MessageAttachment, TranscriptDisplayRow } from '$lib/types/sprocket';

type PromptMessage = Pick<TranscriptDisplayRow, 'id' | 'text' | 'attachments'>;

type Props = {
	message: PromptMessage;
	copied: boolean;
	loadAttachment?: (storageId: MessageAttachment['storageId']) => Promise<string | null>;
	onCopy: () => void;
	onOpenImage: (image: ViewerImage) => void;
};

const userMessageClass =
	'user-bubble w-fit max-w-[33rem] rounded-xl border px-5 py-3.5 text-[15.5px] leading-7 text-foreground';

export default function TranscriptPromptMessage({
	message,
	copied,
	loadAttachment,
	onCopy,
	onOpenImage
}: Props) {
	const attachments = message.attachments ?? [];

	return (
		<div
			data-message-id={message.id}
			data-transcript-anchor={message.id}
			className="flex flex-col items-end gap-1.5"
		>
			{attachments.length > 0 ? (
				<ul className="flex max-w-132 flex-wrap justify-end gap-2" aria-label="Attached files">
					{attachments.map((attachment) => (
						<li key={attachment.storageId}>
							<TranscriptAttachment
								attachment={{ ...attachment, url: null }}
								loadAttachment={loadAttachment}
								onOpen={onOpenImage}
							/>
						</li>
					))}
				</ul>
			) : null}
			{message.text || attachments.length === 0 ? (
				<div className={userMessageClass}>
					<ChatMarkdown
						content={message.text || ' '}
						className="text-foreground"
						openLinksInNewTab
					/>
				</div>
			) : null}
			{message.text ? (
				<button
					type="button"
					className="text-muted-foreground hover:text-muted-foreground inline-flex size-6 items-center justify-center rounded-md transition"
					aria-label={copied ? 'Copied' : 'Copy message'}
					onClick={onCopy}
				>
					{copied ? (
						<Check className="size-3.5" aria-hidden="true" />
					) : (
						<Copy className="size-3.5" aria-hidden="true" />
					)}
				</button>
			) : null}
		</div>
	);
}
