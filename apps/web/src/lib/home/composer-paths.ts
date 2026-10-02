import { useEffect, useState } from 'react';
import type { WorkspaceSearchResult } from '$lib/types/sprocket';

export type ComposerPathSource = {
	workspacePath: string;
	search: (query: string, signal: AbortSignal) => Promise<WorkspaceSearchResult>;
};

type SearchState = {
	source: ComposerPathSource;
	query: string;
	result: WorkspaceSearchResult | null;
	error: boolean;
};

export function useComposerPaths(source: ComposerPathSource | null, query: string | null) {
	const [state, setState] = useState<SearchState | null>(null);
	const [retry, setRetry] = useState(0);

	useEffect(() => {
		if (!source || query === null) return;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout>;

		async function search() {
			if (!source || query === null) return;

			try {
				const result = await source.search(query, controller.signal);

				if (controller.signal.aborted) return;
				setState({ source, query, result, error: false });

				if (result.scanning) timer = setTimeout(search, 250);
			} catch {
				if (!controller.signal.aborted) setState({ source, query, result: null, error: true });
			}
		}

		timer = setTimeout(search, 100);

		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [source, query, retry]);

	const current = state?.source === source && state.query === query ? state : null;

	const loadState: 'unavailable' | 'error' | 'ready' | 'loading' = !source
		? 'unavailable'
		: current?.error
			? 'error'
			: current?.result
				? 'ready'
				: 'loading';

	return {
		loadState,
		entries: current?.result?.entries ?? [],
		scanning: current?.result?.scanning ?? false,
		retry: () => {
			setState(null);
			setRetry((value) => value + 1);
		}
	};
}
