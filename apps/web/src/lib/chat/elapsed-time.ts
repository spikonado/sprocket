import { useEffect, useState } from 'react';

export function useTickingNow(enabled: boolean): number {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		if (!enabled) return;
		setNow(Date.now());
		const interval = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(interval);
	}, [enabled]);
	return now;
}

export function elapsedSeconds(
	startedAt: number | undefined,
	endedAt: number | undefined
): number | undefined {
	if (
		startedAt === undefined ||
		startedAt <= 0 ||
		endedAt === undefined ||
		!Number.isFinite(startedAt) ||
		!Number.isFinite(endedAt)
	)
		return undefined;
	return Math.max(0, Math.floor((endedAt - startedAt) / 1_000));
}
