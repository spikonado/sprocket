import { onMount, untrack } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import { useConvexClient, usePaginatedQuery, useQuery } from 'convex-svelte';
import { api } from '$convex/_generated/api';
import type { Doc } from '$convex/_generated/dataModel';
import type { DesktopApi } from '$lib/types/sprocket';
import { INBOX_STATES, inboxState, type InboxState } from '$convex/lib/inboxState';
import { compareInboxThreads } from './inbox';

export function useInbox(input: {
	userId: () => string | null;
	enabled: () => boolean;
	cacheReady: () => boolean;
	projects: () => string[];
	desktop: () => DesktopApi | null;
}) {
	const client = useConvexClient();
	let connected = $state(false);
	let cached = $state<Doc<'threadRecords'>[]>([]);
	let cacheError = $state<string | null>(null);
	let cacheLoadError = $state<string | null>(null);
	let save = Promise.resolve();
	let savedRecords = new SvelteMap<string, Doc<'threadRecords'>>();
	const projects = useQuery(api.inbox.projects, () => (input.enabled() ? {} : 'skip'));
	const queries = INBOX_STATES.map((state) => ({
		state,
		query: usePaginatedQuery(
			api.inbox.list,
			() => (input.enabled() ? { state, repositoryKeys: input.projects() } : 'skip'),
			{ initialNumItems: 25 }
		)
	}));
	onMount(() => {
		connected = client.connectionState().isWebSocketConnected;
		return client.subscribeToConnectionState((state) => {
			connected = state.isWebSocketConnected;
		});
	});
	$effect.pre(() => {
		input.userId();
		cached = [];
		savedRecords = new SvelteMap();
		cacheError = null;
		cacheLoadError = null;
	});
	$effect(() => {
		const userId = input.userId();
		const desktop = input.desktop();
		const ready = input.cacheReady();
		cacheLoadError = null;
		let cancelled = false;
		if (userId && desktop && ready)
			void (async () => {
				let cursor: string | undefined;
				do {
					const page = await desktop.inboxCache({ userId, cursor });
					if (cancelled) return;
					cached = [
						...new SvelteMap(
							[...page.records, ...cached]
								.filter((row) => row.userId === userId)
								.map((row) => [row._id, row])
						).values()
					];
					cursor = page.cursor ?? undefined;
				} while (cursor);
			})().catch(() => {
				if (!cancelled) cacheLoadError = 'Offline thread history could not be loaded.';
			});
		return () => {
			cancelled = true;
		};
	});
	$effect(() => {
		const userId = input.userId();
		const rows = queries
			.flatMap(({ query }) => query.results)
			.filter((row) => row.userId === userId);
		if (!userId || !rows.length || !connected || !input.enabled()) return;
		untrack(() => {
			const byId = new SvelteMap(cached.map((row) => [row._id, row]));
			for (const row of rows) byId.set(row._id, row);
			cached = [...byId.values()];
		});
	});
	$effect(() => {
		const rows = cached;
		const userId = input.userId();
		const desktop = input.desktop();
		if (!userId || !desktop || !rows.length || !connected) return;
		const timer = setTimeout(() => {
			save = save.then(async () => {
				if (input.userId() !== userId) return;
				try {
					const changed = rows.filter((row) => savedRecords.get(row._id) !== row);
					for (let offset = 0; offset < changed.length; offset += 25) {
						if (input.userId() !== userId) return;
						const batch = changed.slice(offset, offset + 25);
						await desktop.inboxCache({ userId, records: batch });
						if (input.userId() === userId) for (const row of batch) savedRecords.set(row._id, row);
					}
					if (input.userId() === userId) cacheError = null;
				} catch {
					if (input.userId() === userId)
						cacheError = 'Recent changes could not be saved for offline use.';
				}
			});
		}, 300);
		return () => clearTimeout(timer);
	});
	const sections = $derived(
		queries.map(({ state, query }) => {
			const online = connected && input.enabled();
			const fallback = !online || query.status === 'LoadingFirstPage' || query.error;
			const rows = (
				fallback
					? cached
							.filter(
								(row) =>
									inboxState(row) === state &&
									(!input.projects().length || input.projects().includes(row.repositoryKey))
							)
							.sort(compareInboxThreads)
					: query.results
			).filter((row) => row.userId === input.userId());
			const count = projects.data?.projects
				.filter(
					(project) =>
						project.userId === input.userId() &&
						(!input.projects().length || input.projects().includes(project.repositoryKey))
				)
				.reduce((sum, project) => sum + project[state], 0);
			return {
				state,
				rows,
				count: online ? (count ?? rows.length) : rows.length,
				loading: online && query.isLoading,
				canLoadMore: online && query.status === 'CanLoadMore',
				error: query.error?.message,
				loadMore: () => query.loadMore(25)
			};
		})
	);
	return {
		remember(record: Doc<'threadRecords'>) {
			if (record.userId !== input.userId()) return;
			cached = [...new SvelteMap([...cached, record].map((row) => [row._id, row])).values()];
		},
		get sections() {
			return sections;
		},
		get records() {
			return cached;
		},
		get online() {
			return connected && input.enabled();
		},
		get projects() {
			return projects.data?.projects.filter((project) => project.userId === input.userId()) ?? [];
		},
		get migrating() {
			return projects.data?.migrating ?? false;
		},
		get error() {
			return projects.error?.message ?? cacheLoadError ?? cacheError;
		}
	};
}

export type InboxSectionData = {
	state: InboxState;
	rows: Doc<'threadRecords'>[];
	count: number;
	loading: boolean;
	canLoadMore: boolean;
	error?: string;
	loadMore: () => void;
};
