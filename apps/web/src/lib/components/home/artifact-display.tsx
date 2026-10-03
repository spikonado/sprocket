import ArtifactMenu from '$lib/components/artifact-menu';
import { ArrowLeft, Check, Code2, Copy, Eye, Fullscreen } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
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
	const previewDocument = useMemo(
		() => buildArtifactPreviewDocument(artifactType, content),
		[artifactType, content]
	);

	const [showSource, setShowSource] = useState(false);
	const [copied, setCopied] = useState(false);
	const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
						<span className="text-muted-foreground min-w-0 truncate text-[11px]">{localPath}</span>
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
				{onDelete ? <ArtifactMenu title={title} trigger="button" onDelete={onDelete} /> : null}
			</div>
			{localError ? (
				<p role="alert" className="px-3 pb-2 text-[11px] text-amber-800 dark:text-amber-200">
					{localError}
				</p>
			) : null}
			{renderBody(variant === 'full' ? 'h-full' : 'h-64')}
		</div>
	);
}
