import { useEffect, useRef } from 'react';

export default function MarkdownHtml({ html }: { html: string }) {
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const codeBlocks = ref.current?.querySelectorAll<HTMLElement>('pre > code[class]');

		if (!codeBlocks?.length) return;

		const controller = new AbortController();

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

		return () => {
			controller.abort();
		};
	}, [html]);

	return (
		<div ref={ref} className="chat-markdown-html" dangerouslySetInnerHTML={{ __html: html }} />
	);
}
