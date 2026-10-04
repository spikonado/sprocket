import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import CodeCopyButton from './code-copy-button';

type CodeControl = { target: HTMLElement; wrapper: HTMLDivElement; pre: HTMLElement; code: string };

export default function MarkdownHtml({ html }: { html: string }) {
	const ref = useRef<HTMLDivElement>(null);

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
			pre.replaceWith(wrapper);
			wrapper.append(target, pre);
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

	return (
		<>
			<div ref={ref} className="chat-markdown-html" dangerouslySetInnerHTML={{ __html: html }} />
			{controls.html === html
				? controls.blocks.map(({ target, code }, index) =>
						createPortal(<CodeCopyButton code={code} />, target, String(index))
					)
				: null}
		</>
	);
}
