// Agents write prose labels that Mermaid parses as syntax; these escape it as Mermaid entity codes.
export function repairMermaidSource(source: string, diagramType: string) {
	if (diagramType.startsWith('flowchart')) return escapeFlowchartEdgeDashes(source);

	if (diagramType === 'sequence') return escapeSequenceSemicolons(source);

	return source;
}

function escapeFlowchartEdgeDashes(source: string) {
	return source.replace(
		/(--[\t ]+)([^\n]*?)([\t ]+-->)/g,
		(_, open: string, label: string, close: string) =>
			open + label.replaceAll('--', '#45;#45;') + close
	);
}

function escapeSequenceSemicolons(source: string) {
	return source.replace(/(?<!#\w+);/g, '#59;');
}
