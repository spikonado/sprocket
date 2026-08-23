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

/** Ticking-countdown precision: seconds show below a minute, minutes below an hour. */
export function formatCountdownDuration(remainingMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(remainingMs / 1_000));
	const days = Math.floor(totalSeconds / 86_400);
	const hours = Math.floor((totalSeconds % 86_400) / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}
