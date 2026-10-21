import { use, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import CodeBlockControls from './code-block-controls';
import ImageViewer, { type ViewerImage } from './image-viewer';
import { MarkdownFileLinksContext, markdownFileTarget } from '$lib/chat/markdown-file-links';
import { prepareMarkdownImages, type MarkdownImageScope } from '$lib/chat/markdown-images';
import { resolveLocalApiBaseUrl } from '$lib/local/client';

type CodeControl = {
	target: HTMLElement;
	wrapper: HTMLDivElement;
	pre: HTMLElement;
	code: string;
	language?: string;
};

export default function MarkdownHtml({
	html: sourceHtml,
	imageScope
}: {
	html: string;
	imageScope?: MarkdownImageScope;
}) {
	const workspacePath = imageScope?.workspacePath;
	const documentPath = imageScope?.documentPath;

	const html = useMemo(
		() => prepareMarkdownImages(sourceHtml, { workspacePath, documentPath }),
		[sourceHtml, workspacePath, documentPath]
	);

	const ref = useRef<HTMLDivElement>(null);
	const [viewerImage, setViewerImage] = useState<ViewerImage | null>(null);
	const fileLinks = use(MarkdownFileLinksContext);

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
			target.className = 'markdown-code-header';
			pre.replaceWith(wrapper);
			wrapper.append(target, pre);
			const code = block.textContent;

			const language = [...block.classList]
				.find((name) => name.startsWith('language-'))
				?.slice('language-'.length)
				.toLowerCase();

			blocks.push({ target, wrapper, pre, code, language });

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

	function openFileLink(event: MouseEvent) {
		if (!fileLinks || !(event.target instanceof Element)) return;

		const href = event.target.closest('a[href]')?.getAttribute('href');
		const target = href ? markdownFileTarget(href, fileLinks.roots, imageScope) : null;

		if (!target) return;

		event.preventDefault();
		fileLinks.open(target);
	}

	return (
		<>
			<div
				ref={ref}
				className="chat-markdown-html"
				onClick={(event) => {
					if (event.target instanceof HTMLImageElement) openImage(event.target);

					openFileLink(event);
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
			{controls.blocks.map(({ target, code, language, pre }, index) => (
				<CodeBlockControls key={index} target={target} code={code} language={language} pre={pre} />
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
