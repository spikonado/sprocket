import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type CopyState = { status: 'idle' | 'copying' | 'failed' } | { status: 'copied'; code: string };

export default function CodeCopyButton({ code, target }: { code: string; target: HTMLElement }) {
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

	return createPortal(
		<button
			type="button"
			className="markdown-code-copy"
			aria-label={
				copyState.status === 'failed'
					? 'Retry copying code'
					: copiedEarlier
						? 'Copy current code'
						: 'Copy code'
			}
			disabled={copyState.status === 'copying'}
			onClick={() => void copy()}
		>
			{copyState.status === 'copied' ? (
				<Check size={14} aria-hidden="true" />
			) : (
				<Copy size={14} aria-hidden="true" />
			)}
			<span role="status">
				{copyState.status === 'copied'
					? copiedEarlier
						? 'Copied earlier'
						: 'Copied'
					: copyState.status === 'failed'
						? 'Copy failed'
						: 'Copy'}
			</span>
		</button>,
		target
	);
}
