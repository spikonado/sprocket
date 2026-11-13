import ArtifactMenu from '$lib/components/artifact-menu';
import { ArrowLeft, Check, Code2, Copy, Eye, Fullscreen } from 'lucide-react';
import { useMemo, useState } from 'react';
import ChatMarkdown from '$lib/components/chat-markdown';
import LazyJsonRender from '$lib/components/lazy-json-render';
import LazyWiringView from '$lib/components/lazy-wiring-view';
import { useCopyFeedback } from '$lib/components/use-copy-feedback';
import { buildArtifactPreviewDocument, type ArtifactPreviewType } from '$lib/chat/artifact-preview';
import type { ArtifactContent } from '$lib/chat/artifacts';

type Props = {
	title: string;
	artifactType: ArtifactPreviewType;
	content: ArtifactContent;
	workspacePath?: string;
	variant?: 'card' | 'full';
	onOpenFullscreen?: () => void;
	onBack?: () => void;
	onDelete?: () => Promise<void>;
};

export default function ArtifactDisplay({
	title,
	artifactType,
	content,
	workspacePath,
	variant = 'card',
	onOpenFullscreen,
	onBack,
	onDelete
}: Props) {
	const text = content.status === 'ready' ? content.content : null;

	const previewDocument = useMemo(
		() => (text === null ? null : buildArtifactPreviewDocument(artifactType, text)),
		[artifactType, text]
	);

	const hasPreview =
		text !== null &&
		(previewDocument !== null || artifactType === 'json-render' || artifactType === 'wiring');

	const [showSource, setShowSource] = useState(false);
	const { copied, markCopied, resetCopied } = useCopyFeedback();

	async function copyContent(value: string) {
		try {
			await navigator.clipboard.writeText(value);
			markCopied(true);
		} catch {
			resetCopied();
		}
	}

	function renderBody(
		{ content: value, sourcePath }: Extract<ArtifactContent, { status: 'ready' }>,
		frameClass: string
	) {
		const source = (
			<pre className="h-full overflow-auto p-3 pr-10 text-[13px] leading-6">
				<code>{value}</code>
			</pre>
		);

		return (
			<div className="relative min-h-0 flex-1 border-t">
				{hasPreview && showSource ? (
					source
				) : previewDocument ? (
					<iframe
						title={`${title} preview`}
						srcDoc={previewDocument}
						sandbox="allow-scripts"
						className={`block w-full bg-white ${frameClass}`}
					></iframe>
				) : artifactType === 'wiring' ? (
					<div className={`overflow-auto pr-10 pl-3 ${frameClass}`}>
						<LazyWiringView source={value} fallback={source} />
					</div>
				) : hasPreview ? (
					<div className={`overflow-auto pr-10 pl-3 ${frameClass}`}>
						<LazyJsonRender source={value} fallback={source} />
					</div>
				) : (
					<div className="h-full overflow-auto p-3 pr-10">
						<ChatMarkdown
							content={value}
							className="text-foreground text-sm"
							imageScope={{
								workspacePath,
								documentPath: sourcePath
							}}
						/>
					</div>
				)}
				<button
					type="button"
					className="bg-card text-muted-foreground hover:text-foreground absolute top-2 right-2 rounded-md border p-1 transition"
					aria-label={copied ? 'Copied' : 'Copy'}
					onClick={() => void copyContent(value)}
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
						<span className="text-foreground min-w-0 truncate text-sm">{title}</span>
						<span className="text-muted-foreground shrink-0 text-[11px]">{artifactType}</span>
					</div>
				</div>
				{hasPreview ? (
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
			{content.status === 'ready' ? (
				renderBody(content, variant === 'full' ? 'h-full' : 'h-64')
			) : (
				<ArtifactContentStatus content={content} />
			)}
		</div>
	);
}

export function ArtifactContentStatus({
	content
}: {
	content: Exclude<ArtifactContent, { status: 'ready' }>;
}) {
	return content.status === 'loading' ? (
		<p role="status" className="text-muted-foreground border-t p-3 text-sm">
			Loading artifact…
		</p>
	) : (
		<p role="alert" className="border-t p-3 text-sm text-amber-800 dark:text-amber-200">
			{content.error}
		</p>
	);
}
