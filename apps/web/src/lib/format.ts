export function truncatePreview(value: string, limit = 180) {
	if (value.length <= limit) {
		return value;
	}

	return `${value.slice(0, limit)}...`;
}

export function formatCompactCount(value: number) {
	if (value >= 10_000) {
		return `${(value / 1000).toFixed(1)}k`;
	}

	return `${value}`;
}

export function formatRelativeTime(timestamp: number, now = Date.now()) {
	const deltaMs = Math.max(0, now - timestamp);
	const minute = 60_000;
	const hour = 60 * minute;
	const day = 24 * hour;

	if (deltaMs < minute) {
		return 'now';
	}

	if (deltaMs < hour) {
		return `${Math.floor(deltaMs / minute)}m ago`;
	}

	if (deltaMs < day) {
		return `${Math.floor(deltaMs / hour)}h ago`;
	}

	return `${Math.floor(deltaMs / day)}d ago`;
}

export function formatElapsedDuration(totalSeconds: number) {
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;

	if (minutes === 0) {
		return `${seconds}s`;
	}

	return `${minutes}m ${seconds}s`;
}
