import { X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ChatMarkdown from '$lib/components/chat-markdown';
import type { ArtifactEntry } from '$lib/chat/artifacts';
import { buildArtifactPreviewDocument } from '$lib/chat/artifact-preview';

type Props = {
	artifact: ArtifactEntry;
	workspacePath?: string;
	onClose: () => void;
};

export default function ArtifactScreenFullscreen({ artifact, workspacePath, onClose }: Props) {
	const previewDocument = useMemo(
		() => buildArtifactPreviewDocument(artifact.artifactType, artifact.content),
		[artifact.artifactType, artifact.content]
	);

	const rootRef = useRef<HTMLDivElement | null>(null);
	/** Shown only when the Fullscreen API is unavailable or rejects (iframe Escape cannot reach us). */
	const [showFallbackClose, setShowFallbackClose] = useState(false);
	const onCloseRef = useRef(onClose);
	useLayoutEffect(() => {
		onCloseRef.current = onClose;
	}, [onClose]);

	useEffect(() => {
		const el = rootRef.current;

		if (!el) return;

		let active = true;
		// Click handler requests FS on documentElement before this mounts; treat any
		// current fullscreen session as ours so we don't re-request (and bounce) later.
		let wasFullscreen = Boolean(document.fullscreenElement);

		const previouslyFocused =
			document.activeElement instanceof HTMLElement ? document.activeElement : null;

		const close = () => {
			if (!active) return;
			active = false;
			onCloseRef.current();
		};

		const onFullscreenChange = () => {
			if (document.fullscreenElement) {
				wasFullscreen = true;
				setShowFallbackClose(false);

				return;
			}

			if (wasFullscreen) {
				close();
			}
		};

		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (document.querySelector('[data-image-viewer]')) return;

			if (event.key !== 'Escape') return;
			// Claim Escape so an expanded workspace panel underneath does not also collapse.
			event.stopImmediatePropagation();

			// Browser fullscreen already exits on Escape; fullscreenchange handles close.
			if (document.fullscreenElement || wasFullscreen) return;
			event.preventDefault();
			close();
		};

		document.addEventListener('fullscreenchange', onFullscreenChange);
		window.addEventListener('keydown', onKeyDown, true);

		queueMicrotask(() => {
			if (active) el.focus();
		});

		// Parent requests fullscreen in the user-gesture click handler. If that
		// failed or was skipped, expose a dismiss control; do not re-request here
		// (Firefox will deny it outside the gesture and can bounce the session).
		const fallbackTimer = window.setTimeout(() => {
			if (!active || document.fullscreenElement) return;
			setShowFallbackClose(true);
		}, 250);

		return () => {
			active = false;
			window.clearTimeout(fallbackTimer);
			document.removeEventListener('fullscreenchange', onFullscreenChange);
			window.removeEventListener('keydown', onKeyDown, true);

			if (document.fullscreenElement) {
				void document.exitFullscreen?.().catch(() => {});
			}

			const focusTarget = previouslyFocused;
			queueMicrotask(() => {
				if (focusTarget?.isConnected) focusTarget.focus();
			});
		};
	}, []);

	return (
		<div
			ref={rootRef}
			data-artifact-screen-fullscreen=""
			className="bg-background fixed inset-0 z-200 flex h-screen w-screen flex-col outline-none"
			role="dialog"
			aria-modal="true"
			aria-label={`${artifact.title} fullscreen. Press Escape to exit.`}
			tabIndex={-1}
		>
			{previewDocument ? (
				<iframe
					title={`${artifact.title} preview`}
					srcDoc={previewDocument}
					sandbox="allow-scripts"
					className="block h-full w-full flex-1 bg-white"
				></iframe>
			) : (
				<div className="min-h-0 flex-1 overflow-auto p-6">
					<ChatMarkdown
						content={artifact.content}
						className="text-foreground text-sm"
						imageScope={
							workspacePath ? { workspacePath, documentPath: artifact.localPath } : undefined
						}
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
