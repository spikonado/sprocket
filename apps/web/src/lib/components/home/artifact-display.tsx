import ArtifactContextMenu from '$lib/components/artifact-context-menu';
import { ArrowLeft, Check, Code2, Copy, Eye, Fullscreen } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { defaultTreeAdapter, parse } from 'parse5';
import ChatMarkdown from '$lib/components/chat-markdown';
import type { ArtifactType } from '@convex/lib/validators';
import { buildArtifactPreviewDocument } from '$lib/chat/artifact-preview';

type Props = {
	title: string;
	artifactType: ArtifactType;
	content: string;
	localPath?: string;
	localError?: string;
	variant?: 'card' | 'full';
	/** Enter true browser fullscreen for this artifact (content only). */
	onOpenFullscreen?: () => void;
	onBack?: () => void;
	onDelete?: () => Promise<void>;
};

// Sandboxed previews have an opaque origin. Forward only menu-opening gestures;
// the parent still requires the user to choose the deletion action.
const previewMenuBridge = `<script>
window.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  parent.postMessage({ type: 'sprocket-artifact-menu', x: event.clientX, y: event.clientY }, '*');
}, true);
window.addEventListener('keydown', (event) => {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
  event.preventDefault();
  const bounds = event.target.getBoundingClientRect();
  parent.postMessage({ type: 'sprocket-artifact-menu', x: bounds.left, y: bounds.bottom }, '*');
}, true);
</script>`;

const previewMenuMessage = z.object({
	type: z.literal('sprocket-artifact-menu'),
	x: z.number().finite(),
	y: z.number().finite()
});

export default function ArtifactDisplay({
	title,
	artifactType,
	content,
	localPath,
	localError,
	variant = 'card',
	onOpenFullscreen,
	onBack,
	onDelete
}: Props) {
	const hasDeleteAction = Boolean(onDelete);

	const previewDocument = useMemo(() => {
		const document = buildArtifactPreviewDocument(artifactType, content);

		if (!document || !hasDeleteAction) return document;

		// Locate real HTML tokens without rewriting source or loading artifact resources.
		const parsed = parse(document, { sourceCodeLocationInfo: true });

		const root = parsed.childNodes
			.filter(defaultTreeAdapter.isElementNode)
			.find((node) => node.tagName === 'html');

		const head = root?.childNodes
			.filter(defaultTreeAdapter.isElementNode)
			.find((node) => node.tagName === 'head');

		const doctype = parsed.childNodes.find((node) => node.nodeName === '#documentType');

		const offset =
			head?.sourceCodeLocation?.startTag?.endOffset ??
			root?.sourceCodeLocation?.startTag?.endOffset ??
			doctype?.sourceCodeLocation?.endOffset ??
			0;

		return document.slice(0, offset) + previewMenuBridge + document.slice(offset);
	}, [artifactType, content, hasDeleteAction]);

	const [showSource, setShowSource] = useState(false);
	const [copied, setCopied] = useState(false);
	const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const frameRef = useRef<HTMLIFrameElement>(null);

	useEffect(() => {
		if (!onDelete) return;

		function openPreviewMenu(event: MessageEvent) {
			const frame = frameRef.current;

			if (!frame || event.source !== frame.contentWindow) return;
			const parsed = previewMenuMessage.safeParse(event.data);

			if (!parsed.success) return;
			const data = parsed.data;
			const bounds = frame.getBoundingClientRect();
			frame.dispatchEvent(
				new MouseEvent('contextmenu', {
					bubbles: true,
					cancelable: true,
					clientX: bounds.left + Math.max(0, Math.min(data.x, bounds.width)),
					clientY: bounds.top + Math.max(0, Math.min(data.y, bounds.height))
				})
			);
		}

		window.addEventListener('message', openPreviewMenu);

		return () => window.removeEventListener('message', openPreviewMenu);
	}, [onDelete]);

	async function copyContent() {
		try {
			await navigator.clipboard.writeText(content);
			setCopied(true);

			if (copyTimeoutRef.current !== null) {
				clearTimeout(copyTimeoutRef.current);
			}

			copyTimeoutRef.current = setTimeout(() => {
				setCopied(false);
				copyTimeoutRef.current = null;
			}, 1_500);
		} catch {
			setCopied(false);
		}
	}

	useEffect(() => {
		return () => {
			if (copyTimeoutRef.current !== null) {
				clearTimeout(copyTimeoutRef.current);
			}
		};
	}, []);

	function renderBody(frameClass: string) {
		return (
			<div className="relative min-h-0 flex-1 border-t">
				{previewDocument && !showSource ? (
					<iframe
						ref={frameRef}
						title={`${title} preview`}
						srcDoc={previewDocument}
						sandbox="allow-scripts"
						className={`block w-full bg-white ${frameClass}`}
					></iframe>
				) : previewDocument ? (
					<pre className="h-full overflow-auto p-3 pr-10 text-[13px] leading-6">
						<code>{content}</code>
					</pre>
				) : (
					<div className="h-full overflow-auto p-3 pr-10">
						<ChatMarkdown content={content} className="text-foreground text-sm" />
					</div>
				)}
				<button
					type="button"
					className="bg-card text-muted-foreground hover:text-foreground absolute top-2 right-2 rounded-md border p-1 transition"
					aria-label={copied ? 'Copied' : 'Copy'}
					onClick={() => void copyContent()}
				>
					{copied ? (
						<Check className="size-3.5" aria-hidden="true" />
					) : (
						<Copy className="size-3.5" aria-hidden="true" />
					)}
				</button>
			</div>
		);
	}

	return (
		<ArtifactContextMenu title={title} onDelete={onDelete}>
			<div
				className={
					variant === 'full'
						? 'bg-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border'
						: 'bg-card rounded-lg border'
				}
			>
				<div className="flex items-center gap-2 px-3 py-2">
					{onBack ? (
						<button
							type="button"
							className="text-muted-foreground hover:text-foreground shrink-0 transition"
							onClick={onBack}
							aria-label="Back to artifacts"
						>
							<ArrowLeft className="size-4" aria-hidden="true" />
						</button>
					) : null}
					<div className="flex min-w-0 flex-1 flex-col gap-0.5">
						<div className="flex min-w-0 items-center gap-2">
							<span className="text-foreground min-w-0 truncate text-sm font-medium">{title}</span>
							<span className="text-muted-foreground shrink-0 text-[11px]">{artifactType}</span>
						</div>
						{localPath ? (
							<span className="text-muted-foreground min-w-0 truncate text-[11px]">
								{localPath}
							</span>
						) : null}
					</div>
					{previewDocument ? (
						<button
							type="button"
							className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition"
							onClick={() => setShowSource((value) => !value)}
							aria-label={showSource ? 'Show preview' : 'Show source'}
						>
							{showSource ? (
								<>
									<Eye className="size-3.5" aria-hidden="true" />
									Preview
								</>
							) : (
								<>
									<Code2 className="size-3.5" aria-hidden="true" />
									Source
								</>
							)}
						</button>
					) : null}
					{onOpenFullscreen ? (
						<button
							type="button"
							className="text-muted-foreground hover:text-foreground shrink-0 transition"
							onClick={onOpenFullscreen}
							aria-label="Open fullscreen"
							title="Open fullscreen"
						>
							<Fullscreen className="size-4" aria-hidden="true" />
						</button>
					) : null}
				</div>
				{localError ? (
					<p role="alert" className="px-3 pb-2 text-[11px] text-amber-800 dark:text-amber-200">
						{localError}
					</p>
				) : null}
				{renderBody(variant === 'full' ? 'h-full' : 'h-64')}
			</div>
		</ArtifactContextMenu>
	);
}
