import { useEffect, useState } from 'react';
import { highlightCommand, type StyledRun } from '$lib/chat/command-highlighting';

export default function HighlightedCommand({ command }: { command: string }) {
	const [highlighted, setHighlighted] = useState<{ command: string; runs: StyledRun[] }>();

	useEffect(() => {
		const controller = new AbortController();

		void import('$lib/chat/code-highlighting-client')
			.then(({ highlightCodeInWorker }) =>
				highlightCommand(command, (code, language) =>
					highlightCodeInWorker(code, language, controller.signal)
				)
			)
			.then((runs) => {
				if (runs && !controller.signal.aborted) setHighlighted({ command, runs });
			})
			.catch(() => {
				// Keep the plain-text fallback when a lazy chunk or grammar fails.
			});

		return () => controller.abort();
	}, [command]);

	if (highlighted?.command !== command) return command;

	return (
		<span className="shiki">
			{highlighted.runs.map((run, index) => (
				<span key={index} style={run.style}>
					{run.text}
				</span>
			))}
		</span>
	);
}
