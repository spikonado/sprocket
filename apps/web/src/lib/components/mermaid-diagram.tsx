import { useEffect, useState, useSyncExternalStore } from 'react';
import MarkdownHtml from '$lib/components/markdown-html';

let nextDiagramId = 0;

function subscribeToTheme(onChange: () => void) {
	const observer = new MutationObserver(onChange);
	observer.observe(document.documentElement, { attributeFilter: ['data-theme'] });

	return () => observer.disconnect();
}

function readTheme() {
	return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default';
}

async function renderDiagram(source: string, theme: 'dark' | 'default') {
	const { default: mermaid } = await import('mermaid');

	mermaid.initialize({
		startOnLoad: false,
		securityLevel: 'strict',
		suppressErrorRendering: true,
		theme,
		fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-sans')
	});

	return (await mermaid.render(`mermaid-diagram-${nextDiagramId++}`, source)).svg;
}

export default function MermaidDiagram({ source, codeHtml }: { source: string; codeHtml: string }) {
	const theme = useSyncExternalStore(subscribeToTheme, readTheme);
	const [svg, setSvg] = useState<string | null>(null);

	useEffect(() => {
		let current = true;

		renderDiagram(source, theme).then(
			(rendered) => current && setSvg(rendered),
			() => current && setSvg(null)
		);

		return () => {
			current = false;
		};
	}, [source, theme]);

	// The source stays readable while Mermaid loads and when the diagram has a syntax error.
	if (!svg) return <MarkdownHtml html={codeHtml} />;

	return <div className="markdown-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}
