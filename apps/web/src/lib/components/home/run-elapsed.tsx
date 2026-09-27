import { elapsedSeconds, useTickingNow } from '$lib/chat/elapsed-time';
import { formatElapsedDuration } from '$lib/format';

export default function RunElapsed({ startedAt }: { startedAt: number }) {
	const now = useTickingNow(true);
	const seconds = elapsedSeconds(startedAt, now);
	return seconds === undefined ? null : formatElapsedDuration(seconds);
}
