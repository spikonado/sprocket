export function formatElapsedDuration(totalSeconds: number) {
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;

	if (minutes === 0) {
		return `${seconds}s`;
	}

	return `${minutes}m ${seconds}s`;
}

/** Compact human duration for countdowns; rounds up so "0m" never shows. */
export function formatRemainingDuration(remainingMs: number): string {
	const milliseconds = Math.max(0, remainingMs);
	const hours = Math.ceil(milliseconds / 3_600_000);
	if (hours >= 24) {
		const days = Math.floor(hours / 24);
		const restHours = hours % 24;
		return restHours > 0 ? `${days}d ${restHours}h` : `${days}d`;
	}
	if (milliseconds >= 3_600_000) {
		return `${hours}h`;
	}
	return `${Math.max(1, Math.ceil(milliseconds / 60_000))}m`;
}
