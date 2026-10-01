import { useCallback, useEffect, useRef, useState } from 'react';
import { convexClientErrorMessage } from '$lib/convex-error';
import type { ChatGptStatus, DesktopApi } from '$lib/types/sprocket';

type StatusApi = Pick<DesktopApi, 'fetchChatGptStatus'>;

type StatusState = {
	api: StatusApi;
	userId: string;
	status: ChatGptStatus | null;
	loading: boolean;
	error: string | null;
};

type Subscription = {
	api: StatusApi;
	userId: string;
	publish: (status: ChatGptStatus) => void;
	refresh: () => void;
};

export function useChatGptStatus(api: StatusApi | null, userId: string | null) {
	const [state, setState] = useState<StatusState | null>(null);
	const subscriptionRef = useRef<Subscription | null>(null);

	const publish = useCallback(
		(status: ChatGptStatus) => {
			const subscription = subscriptionRef.current;

			if (subscription?.api === api && subscription.userId === userId) subscription.publish(status);
		},
		[api, userId]
	);

	const refresh = useCallback(() => {
		const subscription = subscriptionRef.current;

		if (subscription?.api === api && subscription.userId === userId) subscription.refresh();
	}, [api, userId]);

	useEffect(() => {
		if (!api || !userId) return;
		const client = api;
		const user = userId;

		const initialState: StatusState = {
			api: client,
			userId: user,
			status: null,
			loading: true,
			error: null
		};

		setState(initialState);
		let generation = 0;
		let stopped = false;
		let inFlight = false;
		let refreshQueued = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let controller: AbortController | undefined;

		function accept(status: ChatGptStatus) {
			setState({ ...initialState, status, loading: false, error: status.error ?? null });
		}

		async function refresh() {
			if (stopped || inFlight || document.visibilityState === 'hidden') return;
			clearTimeout(timer);
			inFlight = true;
			const requestGeneration = generation;
			const requestController = new AbortController();
			controller = requestController;
			const timeout = setTimeout(() => requestController.abort(), 30_000);

			try {
				const next = await client.fetchChatGptStatus({ userId: user }, requestController.signal);

				if (stopped || requestGeneration !== generation) return;
				accept(next);
			} catch (failure) {
				if (stopped || requestGeneration !== generation) return;

				const error = requestController.signal.aborted
					? 'Checking ChatGPT status timed out. Retrying automatically.'
					: (failure instanceof Error && convexClientErrorMessage(failure)) ||
						'Could not load ChatGPT status.';

				setState((previous) => previous && { ...previous, loading: false, error });
			} finally {
				clearTimeout(timeout);
				inFlight = false;

				if (!stopped) {
					timer = setTimeout(() => void refresh(), refreshQueued ? 0 : 60_000);
					refreshQueued = false;
				}
			}
		}

		const refreshOnReturn = () => {
			if (stopped || document.visibilityState === 'hidden') return;

			if (inFlight) {
				refreshQueued = true;

				return;
			}

			void refresh();
		};

		subscriptionRef.current = {
			api: client,
			userId: user,
			publish: (status) => {
				generation += 1;
				accept(status);
			},
			refresh: refreshOnReturn
		};
		window.addEventListener('focus', refreshOnReturn);
		window.addEventListener('online', refreshOnReturn);
		document.addEventListener('visibilitychange', refreshOnReturn);
		void refresh();

		return () => {
			stopped = true;
			controller?.abort();
			clearTimeout(timer);
			subscriptionRef.current = null;
			window.removeEventListener('focus', refreshOnReturn);
			window.removeEventListener('online', refreshOnReturn);
			document.removeEventListener('visibilitychange', refreshOnReturn);
		};
	}, [api, userId]);

	const current = api && userId && state?.api === api && state.userId === userId ? state : null;

	return {
		status: current?.status ?? null,
		loading: current?.loading ?? Boolean(api && userId),
		error: current?.error ?? null,
		publish,
		refresh
	};
}
