export function escapeFlowchartEdgeDashes(source: string) {
	return source.replace(
		/(--[\t ]+)([^\n]*?)([\t ]+-->)/g,
		(_, open: string, label: string, close: string) =>
			open + label.replaceAll('--', '#45;#45;') + close
	);
}
