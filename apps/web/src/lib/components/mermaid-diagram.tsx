import { useEffect, useState, useSyncExternalStore } from 'react';
import { repairMermaidSource } from '$lib/chat/mermaid-repair';
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

	try {
		return (await mermaid.render(`mermaid-diagram-${nextDiagramId++}`, source)).svg;
	} catch (error) {
		const repaired = repairMermaidSource(source, mermaid.detectType(source));

		if (repaired === source) throw error;

		return (await mermaid.render(`mermaid-diagram-${nextDiagramId++}`, repaired)).svg;
	}
}

export default function MermaidDiagram({ source, codeHtml }: { source: string; codeHtml: string }) {
	const theme = useSyncExternalStore(subscribeToTheme, readTheme);
	const [result, setResult] = useState<{ source: string; svg: string | null }>();

	useEffect(() => {
		let current = true;

		renderDiagram(source, theme).then(
			(svg) => current && setResult({ source, svg }),
			() => current && setResult({ source, svg: null })
		);

		return () => {
			current = false;
		};
	}, [source, theme]);

	const latest = result?.source === source ? result : undefined;

	if (!latest?.svg) {
		return (
			<>
				{latest && <p className="text-muted-foreground text-sm">Could not render diagram.</p>}
				<MarkdownHtml html={codeHtml} />
			</>
		);
	}

	return <div className="markdown-mermaid" dangerouslySetInnerHTML={{ __html: latest.svg }} />;
}
