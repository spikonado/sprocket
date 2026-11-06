import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';

export type AsyncResource<T> =
	| { status: 'idle' }
	| { status: 'loading' }
	| { status: 'loaded'; value: T }
	| { status: 'failed'; error: Error };

const RETRY_BASE_MS = 1_000;

const RETRY_MAX_MS = 15_000;

/**
 * Retries failures with a backoff and starts over when `key` changes. A retry keeps showing the
 * last failure until it succeeds. `set` replaces the value and drops any load in flight.
 */
export function useAsyncResource<T>(
	key: string | null,
	load: () => Promise<T>
): [AsyncResource<T>, (value: T) => void] {
	const [state, setState] = useState<{ key: string; resource: AsyncResource<T> } | null>(null);
	const loadEvent = useEffectEvent(load);
	const attempt = useRef(0);

	useEffect(() => {
		if (key === null) return;
		const loading = key;
		const current = ++attempt.current;
		let retry: ReturnType<typeof setTimeout> | undefined;

		async function run(failures: number) {
			try {
				const value = await loadEvent();

				if (attempt.current === current)
					setState({ key: loading, resource: { status: 'loaded', value } });
			} catch (error) {
				if (attempt.current !== current) return;
				setState({
					key: loading,
					resource: {
						status: 'failed',
						error: error instanceof Error ? error : new Error(String(error))
					}
				});
				retry = setTimeout(
					() => {
						if (attempt.current === current) void run(failures + 1);
					},
					Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** failures)
				);
			}
		}

		void run(0);

		return () => {
			attempt.current += 1;
			clearTimeout(retry);
		};
	}, [key]);

	const set = useCallback(
		(value: T) => {
			if (key === null) return;
			attempt.current += 1;
			setState({ key, resource: { status: 'loaded', value } });
		},
		[key]
	);

	const resource: AsyncResource<T> =
		key === null ? { status: 'idle' } : state?.key === key ? state.resource : { status: 'loading' };

	return [resource, set];
}
