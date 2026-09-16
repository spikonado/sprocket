import { usePaginatedQuery } from 'convex-svelte';
import { api } from '$convex/_generated/api';
import type { Doc } from '$convex/_generated/dataModel';
import { INBOX_STATES, type InboxState } from '$convex/lib/inboxState';

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
				const repositoryKeys = input.projects();
				const sectionOpen = state === 'unsettled' || input.settledOpen();
				return input.enabled() && sectionOpen && repositoryKeys.length > 0
					? { state, repositoryKeys }
					: 'skip';
			},
			{ initialNumItems: 25 }
		)
	}));

	const sections = $derived(
		queries.map(({ state, query }) => ({
			state,
			rows: query.results,
			loading: query.isLoading,
			canLoadMore: query.status === 'CanLoadMore',
			error: query.error?.message,
			loadMore: () => query.loadMore(25)
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
