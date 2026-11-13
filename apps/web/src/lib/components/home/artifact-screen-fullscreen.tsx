import { X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import ChatMarkdown from '$lib/components/chat-markdown';
import LazyJsonRender from '$lib/components/lazy-json-render';
import LazyWiringView from '$lib/components/lazy-wiring-view';
import { ArtifactContentStatus } from '$lib/components/home/artifact-display';
import type { ArtifactContent, ArtifactEntry } from '$lib/chat/artifacts';
import { buildArtifactPreviewDocument } from '$lib/chat/artifact-preview';
import { useEscapeLayer } from '$lib/use-escape-layer';
import { useLatest } from '$lib/use-latest';

type Props = {
	artifact: ArtifactEntry;
	content: ArtifactContent;
	workspacePath?: string;
	fullscreenRequest: Promise<boolean>;
	onClose: () => void;
};

/** Call from the opening click: Firefox denies fullscreen requests made outside the gesture. */
export function requestArtifactFullscreen(): Promise<boolean> {
	if (document.fullscreenElement) return Promise.resolve(true);

	return (
		document.documentElement.requestFullscreen?.().then(
			() => true,
			() => false
		) ?? Promise.resolve(false)
	);
}

export default function ArtifactScreenFullscreen({
	artifact,
	content,
	workspacePath,
	fullscreenRequest,
	onClose
}: Props) {
	const text = content.status === 'ready' ? content.content : null;

	const previewDocument = useMemo(
		() => (text === null ? null : buildArtifactPreviewDocument(artifact.artifactType, text)),
		[artifact.artifactType, text]
	);

	const rootRef = useRef<HTMLDivElement | null>(null);
	// Escape pressed inside the preview iframe never reaches this page.
	const [showFallbackClose, setShowFallbackClose] = useState(false);
	const isTopLayer = useEscapeLayer(onClose);
	const onCloseRef = useLatest(onClose);

	useEffect(() => {
		const el = rootRef.current;

		if (!el) return;

		let active = true;

		const previouslyFocused =
			document.activeElement instanceof HTMLElement ? document.activeElement : null;

		void fullscreenRequest.then((entered) => {
			if (active && !entered) setShowFallbackClose(true);
		});

		const onFullscreenChange = () => {
			if (document.fullscreenElement) return;

			if (isTopLayer()) onCloseRef.current();
			else setShowFallbackClose(true);
		};

		document.addEventListener('fullscreenchange', onFullscreenChange);

		queueMicrotask(() => {
			if (active) el.focus();
		});

		return () => {
			active = false;
			document.removeEventListener('fullscreenchange', onFullscreenChange);

			if (document.fullscreenElement) {
				void document.exitFullscreen?.().catch(() => {});
			}

			const focusTarget = previouslyFocused;
			queueMicrotask(() => {
				if (focusTarget?.isConnected) focusTarget.focus();
			});
		};
	}, [fullscreenRequest, isTopLayer, onCloseRef]);

	return (
		<div
			ref={rootRef}
			className="bg-background fixed inset-0 z-200 flex flex-col outline-none"
			role="dialog"
			aria-modal="true"
			aria-label={`${artifact.title} fullscreen. Press Escape to exit.`}
			tabIndex={-1}
		>
			{content.status !== 'ready' ? (
				<ArtifactContentStatus content={content} />
			) : previewDocument ? (
				<iframe
					title={`${artifact.title} preview`}
					srcDoc={previewDocument}
					sandbox="allow-scripts"
					className="block h-full w-full flex-1 bg-white"
				></iframe>
			) : artifact.artifactType === 'json-render' ? (
				<div className="min-h-0 flex-1 overflow-auto px-6">
					<LazyJsonRender
						source={content.content}
						fallback={<pre className="text-[13px] leading-6">{content.content}</pre>}
					/>
				</div>
			) : artifact.artifactType === 'wiring' ? (
				<div className="min-h-0 flex-1 overflow-auto px-6">
					<LazyWiringView
						source={content.content}
						fallback={<pre className="text-[13px] leading-6">{content.content}</pre>}
					/>
				</div>
			) : (
				<div className="min-h-0 flex-1 overflow-auto p-6">
					<ChatMarkdown
						content={content.content}
						className="text-foreground text-sm"
						imageScope={{ workspacePath, documentPath: content.sourcePath }}
					/>
				</div>
			)}
			{showFallbackClose ? (
				<button
					type="button"
					className="bg-background/90 text-muted-foreground hover:text-foreground absolute top-3 right-3 z-10 rounded-md border p-2 transition"
					onClick={onClose}
					aria-label="Exit fullscreen"
				>
					<X className="size-4" aria-hidden="true" />
				</button>
			) : null}
		</div>
	);
}
