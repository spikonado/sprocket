import { useEffect, useRef } from 'react';

export default function MarkdownHtml({ html }: { html: string }) {
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const codeBlocks = ref.current?.querySelectorAll<HTMLElement>('pre > code[class]');

		if (!codeBlocks?.length) return;

		let cancelled = false;

		for (const block of codeBlocks) {
			const language = [...block.classList]
				.find((name) => name.startsWith('language-'))
				?.slice('language-'.length);

			if (!language) continue;

			const code = block.textContent;

			// Keep very large pasted files readable without creating a span for every token.
			if (code.length > 50_000) continue;

			void import('$lib/chat/code-highlighting-client')
				.then(({ highlightCodeInWorker }) =>
					cancelled ? null : highlightCodeInWorker(code, language)
				)
				.then((lines) => {
					if (!lines || cancelled) return;

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

		return () => {
			cancelled = true;
		};
	}, [html]);

	return (
		<div ref={ref} className="chat-markdown-html" dangerouslySetInnerHTML={{ __html: html }} />
	);
}
