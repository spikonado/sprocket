import { useCallback, useEffect, useRef, useState } from 'react';

const COPIED_FEEDBACK_MS = 2_000;

/** Tracks which item shows "Copied" feedback; it clears itself after a short delay. */
export function useCopyFeedback<Key = true>() {
	const [copied, setCopied] = useState<Key | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

	useEffect(() => () => clearTimeout(timer.current), []);

	const markCopied = useCallback((key: Key) => {
		clearTimeout(timer.current);
		setCopied(key);
		timer.current = setTimeout(() => setCopied(null), COPIED_FEEDBACK_MS);
	}, []);

	const resetCopied = useCallback(() => {
		clearTimeout(timer.current);
		setCopied(null);
	}, []);

	return { copied, markCopied, resetCopied };
}
