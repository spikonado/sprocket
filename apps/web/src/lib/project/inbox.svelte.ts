import { usePaginatedQuery } from 'convex-svelte';
import { api } from '$convex/_generated/api';
import type { Doc } from '$convex/_generated/dataModel';
import { INBOX_STATES, type InboxState } from '$convex/lib/inboxState';

const INBOX_PAGE_SIZE = 10;

export function normalizeRepositoryKeys(repositoryKeys: string[]): string[] {
	return [...repositoryKeys].sort().filter((key, index, sorted) => key !== sorted[index - 1]);
}

export function useThreadInbox(input: {
	enabled: () => boolean;
	projects: () => string[];
	settledOpen: () => boolean;
}) {
	const queries = INBOX_STATES.map((state) => ({
		state,
		query: usePaginatedQuery(
			api.inbox.list,
			() => {
				const repositoryKeys = normalizeRepositoryKeys(input.projects());
				const sectionOpen = state === 'unsettled' || input.settledOpen();
				return input.enabled() && sectionOpen && repositoryKeys.length > 0
					? { state, repositoryKeys }
					: 'skip';
			},
			{ initialNumItems: INBOX_PAGE_SIZE }
		)
	}));

	const sections = $derived(
		queries.map(({ state, query }) => ({
			state,
			rows: query.results,
			loading: query.isLoading,
			canLoadMore: query.status === 'CanLoadMore',
			error: query.error?.message,
			loadMore: () => query.loadMore(INBOX_PAGE_SIZE)
		}))
	);

	return {
		get sections() {
			return sections;
		}
	};
}

export type InboxSectionData = {
	state: InboxState;
	rows: Doc<'threadRecords'>[];
	loading: boolean;
	canLoadMore: boolean;
	error?: string;
	loadMore: () => void;
};
