import { Check, CircleAlert, Copy, WrapText } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type CopyState = { status: 'idle' | 'copying' | 'failed' } | { status: 'copied'; code: string };

export default function CodeBlockControls({
	code,
	language,
	pre,
	target
}: {
	code: string;
	language?: string;
	pre: HTMLElement;
	target: HTMLElement;
}) {
	const [copyState, setCopyState] = useState<CopyState>({ status: 'idle' });
	const disposed = useRef(false);
	const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	useEffect(() => {
		disposed.current = false;

		return () => {
			disposed.current = true;
			clearTimeout(resetTimer.current);
		};
	}, []);

	async function copy() {
		const codeSnapshot = code;
		clearTimeout(resetTimer.current);
		setCopyState({ status: 'copying' });

		try {
			await navigator.clipboard.writeText(codeSnapshot);

			if (disposed.current) return;

			setCopyState({ status: 'copied', code: codeSnapshot });
			resetTimer.current = setTimeout(() => setCopyState({ status: 'idle' }), 2_000);
		} catch {
			if (!disposed.current) setCopyState({ status: 'failed' });
		}
	}

	const copiedEarlier = copyState.status === 'copied' && copyState.code !== code;

	const label =
		copyState.status === 'failed'
			? 'Retry copying code'
			: copiedEarlier
				? 'Copy current code'
				: 'Copy code';

	const feedback =
		copyState.status === 'copied'
			? copiedEarlier
				? 'Copied earlier'
				: 'Copied'
			: copyState.status === 'failed'
				? 'Copy failed'
				: copyState.status === 'copying'
					? 'Copying'
					: 'Copy';

	const [wrapped, setWrapped] = useState(false);
	const wrapLabel = wrapped ? 'Disable line wrapping' : 'Enable line wrapping';

	const badge =
		language === 'typescript' ? 'ts' : language === 'javascript' ? 'js' : language || 'text';

	useEffect(() => {
		pre.classList.toggle('markdown-code-wrap', wrapped);

		return () => pre.classList.remove('markdown-code-wrap');
	}, [pre, wrapped]);

	return createPortal(
		<>
			<span className="markdown-code-language" title={language || 'Plain text'}>
				{badge}
			</span>
			<div className="markdown-code-actions">
				<button
					type="button"
					className="markdown-code-action"
					aria-label={wrapLabel}
					aria-pressed={wrapped}
					title={wrapLabel}
					onClick={() => setWrapped((current) => !current)}
				>
					<WrapText size={16} aria-hidden="true" />
				</button>
				<button
					type="button"
					className="markdown-code-action"
					aria-label={label}
					title={feedback === 'Copy' ? label : `${feedback}. ${label}`}
					disabled={copyState.status === 'copying'}
					onClick={() => void copy()}
				>
					{copyState.status === 'copied' && !copiedEarlier ? (
						<Check size={16} aria-hidden="true" />
					) : copyState.status === 'failed' ? (
						<CircleAlert size={16} aria-hidden="true" />
					) : (
						<Copy size={16} aria-hidden="true" />
					)}
					<span className="sr-only" role="status">
						{feedback}
					</span>
				</button>
			</div>
		</>,
		target
	);
}
