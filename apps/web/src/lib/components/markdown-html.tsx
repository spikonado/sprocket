import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import CodeCopyButton from './code-copy-button';
import ImageViewer, { type ViewerImage } from './image-viewer';
import { prepareMarkdownImages, type MarkdownImageScope } from '$lib/chat/markdown-images';
import { resolveLocalApiBaseUrl } from '$lib/local/client';
import { watchMarkdownImage } from '$lib/chat/markdown-image-watch';

type CodeControl = { target: HTMLElement; wrapper: HTMLDivElement; pre: HTMLElement; code: string };

export default function MarkdownHtml({
	html: sourceHtml,
	imageScope
}: {
	html: string;
	imageScope?: MarkdownImageScope;
}) {
	const workspacePath = imageScope?.workspacePath;
	const documentPath = imageScope?.documentPath;
	const userId = imageScope?.transcript?.userId;
	const threadId = imageScope?.transcript?.threadId;

	const html = useMemo(
		() =>
			prepareMarkdownImages(sourceHtml, {
				workspacePath,
				documentPath,
				transcript: userId && threadId ? { userId, threadId } : undefined
			}),
		[sourceHtml, workspacePath, documentPath, userId, threadId]
	);

	const ref = useRef<HTMLDivElement>(null);
	const [viewerImage, setViewerImage] = useState<ViewerImage | null>(null);

	useEffect(() => {
		const images = ref.current?.querySelectorAll<HTMLImageElement>('img[data-local-image-url]');

		const stops = [...(images ?? [])].map((image) => {
			const source = image.getAttribute('data-local-image-url');

			if (!source) return () => {};

			const alt = image.alt;

			return watchMarkdownImage(source, (url) => {
				const previousUrl = image.src;
				image.classList.remove('markdown-image-error');
				image.alt = alt;

				if (!image.closest('a')) {
					image.tabIndex = 0;
					image.setAttribute('role', 'button');
					image.setAttribute('aria-label', `View ${alt || 'image'}`);
				}

				image.src = url;
				setViewerImage((current) => (current?.url === previousUrl ? { ...current, url } : current));
			});
		});

		return () => {
			for (const stop of stops) stop();
		};
	}, [html]);

	const [controls, setControls] = useState<{ html: string; blocks: CodeControl[] }>({
		html,
		blocks: []
	});

	useEffect(() => {
		const codeBlocks = ref.current?.querySelectorAll<HTMLElement>('pre > code') ?? [];

		if (!codeBlocks.length) {
			setControls({ html, blocks: [] });

			return;
		}

		const controller = new AbortController();
		const blocks: CodeControl[] = [];

		for (const block of codeBlocks) {
			const pre = block.parentElement;

			if (!pre) continue;

			const wrapper = document.createElement('div');
			wrapper.className = 'markdown-code-block';
			const target = document.createElement('div');
			target.className = 'markdown-code-controls';
			pre.replaceWith(wrapper);
			wrapper.append(pre, target);
			const code = block.textContent;
			blocks.push({ target, wrapper, pre, code });

			const language = [...block.classList]
				.find((name) => name.startsWith('language-'))
				?.slice('language-'.length);

			if (!language) continue;

			// Keep very large pasted files readable without creating a span for every token.
			if (code.length > 50_000) continue;

			void import('$lib/chat/code-highlighting-client')
				.then(({ highlightCodeInWorker }) =>
					controller.signal.aborted
						? null
						: highlightCodeInWorker(code, language, controller.signal)
				)
				.then((lines) => {
					if (!lines || controller.signal.aborted) return;

					const fragment = document.createDocumentFragment();

					for (const [index, line] of lines.entries()) {
						if (index > 0) fragment.append('\n');

						for (const token of line) {
							const span = document.createElement('span');
							span.textContent = token.content;

							for (const [property, value] of Object.entries(token.htmlStyle ?? {})) {
								span.style.setProperty(property, String(value));
							}

							fragment.append(span);
						}
					}

					block.replaceChildren(fragment);
					block.classList.add('shiki');
				})
				.catch(() => {
					// Keep the readable plain-code fallback when a lazy chunk or grammar fails.
				});
		}

		setControls({ html, blocks });

		return () => {
			controller.abort();

			for (const { wrapper, pre } of blocks) {
				wrapper.replaceWith(pre);
			}
		};
	}, [html]);

	function openImage(image: HTMLImageElement) {
		if (
			!image.getAttribute('src') ||
			image.closest('a') ||
			image.classList.contains('markdown-image-error')
		)
			return;

		const url = new URL(image.src);
		const localImage = image.src.startsWith(`${resolveLocalApiBaseUrl()}/api/workspace/image?`);
		setViewerImage({
			url: image.src,
			name: image.alt || 'Image',
			mediaType: '',
			readActions:
				localImage || !/^https?:$/.test(url.protocol) || url.origin === window.location.origin
		});
	}

	return (
		<>
			<div
				ref={ref}
				className="chat-markdown-html"
				onClick={(event) => {
					if (event.target instanceof HTMLImageElement) openImage(event.target);
				}}
				onKeyDown={(event) => {
					if (
						event.target instanceof HTMLImageElement &&
						(event.key === 'Enter' || event.key === ' ')
					) {
						event.preventDefault();
						openImage(event.target);
					}
				}}
				onErrorCapture={(event) => {
					if (
						!(event.target instanceof HTMLImageElement) ||
						event.target.classList.contains('markdown-image-error')
					)
						return;

					const image = event.target;
					image.classList.add('markdown-image-error');
					image.alt = `${image.alt || 'Image'} (unavailable)`;
					image.removeAttribute('role');
					image.removeAttribute('tabindex');
					image.removeAttribute('aria-label');
				}}
				dangerouslySetInnerHTML={{ __html: html }}
			/>
			{controls.blocks.map(({ target, code }, index) => (
				<CodeCopyButton key={index} target={target} code={code} />
			))}
			{viewerImage
				? createPortal(
						<ImageViewer image={viewerImage} onClose={() => setViewerImage(null)} />,
						document.body
					)
				: null}
		</>
	);
}
