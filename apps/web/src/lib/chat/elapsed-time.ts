import { createSubscriber } from 'svelte/reactivity';

const subscribe = createSubscriber((update) => {
	const interval = setInterval(update, 1_000);
	return () => clearInterval(interval);
});

export function tickingNow(): number {
	subscribe();
	return Date.now();
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
