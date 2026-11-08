import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { LocalApi } from '$lib/types/sprocket';

const installPollMs = 2_000;

/** Status of a CLI on the local server's machine. Changing `refreshKey` checks again, since the
 * user may have installed or signed in from a terminal. */
export function useLocalCliStatus<TStatus extends { state: string }>({
	localApi,
	userId,
	refreshKey,
	fetchStatus,
	failureMessage
}: {
	localApi: LocalApi | null;
	userId: string | null;
	refreshKey: unknown;
	fetchStatus: (api: LocalApi, userId: string) => Promise<TStatus>;
	failureMessage: string;
}) {
	const [status, setStatus] = useState<TStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	const generation = useRef(0);

	function update(next: TStatus) {
		generation.current += 1;
		setStatus(next);
		setError(null);
	}

	const load = useEffectEvent((api: LocalApi, forUserId: string) => {
		const loadGeneration = ++generation.current;

		const current = () => loadGeneration === generation.current;

		fetchStatus(api, forUserId)
			.then((next) => {
				if (current()) update(next);
			})
			.catch((caught: Error) => {
				if (current()) setError(caught.message || failureMessage);
			});
	});

	useEffect(() => {
		if (status?.state !== 'installing' || !localApi || !userId) return;

		const timer = setTimeout(() => load(localApi, userId), installPollMs);

		return () => clearTimeout(timer);
	}, [status, localApi, userId]);

	useEffect(() => {
		if (!userId || !localApi) {
			setStatus(null);
			setError(null);

			return;
		}

		load(localApi, userId);

		return () => {
			generation.current += 1;
		};
	}, [userId, localApi, refreshKey]);

	return { status, error, update };
}
