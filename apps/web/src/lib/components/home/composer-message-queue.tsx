import {
	ChevronDown,
	CircleAlert,
	Clock3,
	ListOrdered,
	LoaderCircle,
	Paperclip,
	RotateCcw,
	X
} from 'lucide-react';
import { useId, useState } from 'react';
import type { ComposerQueuedMessage } from './prompt-composer';

export default function ComposerMessageQueue({
	messages,
	onRemove,
	onRetry
}: {
	messages: ComposerQueuedMessage[];
	onRemove?: (id: string) => void;
	onRetry?: (id: string) => void;
}) {
	const [expanded, setExpanded] = useState(true);
	const listId = useId();
	const hasFailure = messages.some((message) => message.status === 'failed');

	return (
		<section
			aria-label="Message queue"
			className="border-hairline bg-surface mx-auto -mb-4 w-[calc(100%-1rem)] max-w-[47rem] rounded-t-2xl border px-2 pt-1.5 pb-5"
		>
			<button
				type="button"
				className="text-muted-foreground hover:text-foreground focus-visible:ring-primary flex min-h-7 w-full cursor-pointer items-center gap-2 rounded-lg px-1.5 text-xs transition-colors focus-visible:ring-2 focus-visible:outline-none"
				aria-label={expanded ? 'Collapse queued messages' : 'Expand queued messages'}
				aria-expanded={expanded}
				aria-controls={listId}
				onClick={() => setExpanded((value) => !value)}
			>
				<ListOrdered className="size-3.5 shrink-0" aria-hidden="true" />
				<span>Queued</span>
				{hasFailure ? <span className="text-destructive text-[11px]">Needs attention</span> : null}
				<span className="flex-1" />
				<span className="bg-hover-fill rounded px-1.5 text-[11px] tabular-nums" role="status">
					{messages.length}
					<span className="sr-only"> queued messages</span>
				</span>
				<ChevronDown className={`size-3.5 ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
			</button>
			<ol
				id={listId}
				aria-label="Queued messages"
				className="max-h-32 overflow-y-auto"
				hidden={!expanded}
			>
				{messages.map((message) => (
					<li key={message.id} className="flex min-h-7 items-center gap-2 rounded-lg px-1.5 py-0.5">
						{message.status === 'failed' ? (
							<CircleAlert className="text-destructive size-3 shrink-0" aria-hidden="true" />
						) : message.status === 'sending' ? (
							<LoaderCircle
								className="text-muted-foreground size-3 shrink-0 animate-spin motion-reduce:animate-none"
								aria-hidden="true"
							/>
						) : (
							<Clock3 className="text-muted-foreground size-3 shrink-0" aria-hidden="true" />
						)}
						<div className="min-w-0 flex-1">
							<p className="text-foreground truncate text-xs leading-5" title={message.prompt}>
								{message.prompt}
								<span className="sr-only"> ({message.status})</span>
							</p>
							{message.status === 'failed' ? (
								<p
									className="text-destructive truncate text-[11px] leading-4"
									title={message.error}
								>
									{message.error ?? 'Could not send. Retry or remove this message.'}
								</p>
							) : null}
						</div>
						{message.attachmentNames.length > 0 ? (
							<span
								className="text-muted-foreground flex shrink-0 items-center gap-1 text-[11px]"
								title={message.attachmentNames.join(', ')}
							>
								<Paperclip className="size-3" aria-hidden="true" />
								{message.attachmentNames.length}
								<span className="sr-only"> attachments: {message.attachmentNames.join(', ')}</span>
							</span>
						) : null}
						{message.status === 'failed' ? (
							<button
								type="button"
								className="text-muted-foreground enabled:hover:bg-hover-fill enabled:hover:text-foreground focus-visible:ring-primary flex size-6 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:outline-none enabled:cursor-pointer disabled:opacity-40"
								aria-label={`Retry queued message: ${message.prompt}`}
								title="Retry"
								disabled={!onRetry}
								onClick={() => onRetry?.(message.id)}
							>
								<RotateCcw className="size-3" aria-hidden="true" />
							</button>
						) : null}
						{message.status !== 'sending' ? (
							<button
								type="button"
								className="text-muted-foreground enabled:hover:bg-hover-fill enabled:hover:text-foreground focus-visible:ring-primary flex size-6 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:outline-none enabled:cursor-pointer disabled:opacity-40"
								aria-label={`Remove queued message: ${message.prompt}`}
								title="Remove"
								disabled={!onRemove}
								onClick={() => onRemove?.(message.id)}
							>
								<X className="size-3" aria-hidden="true" />
							</button>
						) : null}
					</li>
				))}
			</ol>
		</section>
	);
}
