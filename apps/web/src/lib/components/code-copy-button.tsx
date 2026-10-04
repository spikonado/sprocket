import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export default function CodeCopyButton({ code }: { code: string }) {
	const [status, setStatus] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
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
		clearTimeout(resetTimer.current);
		setStatus('copying');

		try {
			await navigator.clipboard.writeText(code);

			if (disposed.current) return;

			setStatus('copied');
			resetTimer.current = setTimeout(() => setStatus('idle'), 2_000);
		} catch {
			if (!disposed.current) setStatus('failed');
		}
	}

	return (
		<button
			type="button"
			className="markdown-code-copy"
			aria-label={status === 'failed' ? 'Retry copying code' : 'Copy code'}
			disabled={status === 'copying'}
			onClick={() => void copy()}
		>
			{status === 'copied' ? (
				<Check size={14} aria-hidden="true" />
			) : (
				<Copy size={14} aria-hidden="true" />
			)}
			<span role="status">
				{status === 'copied' ? 'Copied' : status === 'failed' ? 'Copy failed' : 'Copy'}
			</span>
		</button>
	);
}
