import { usePaginatedQuery_experimental as usePaginatedQueryResult } from 'convex/react';
import { api } from '$convex/_generated/api';
import type { Doc } from '$convex/_generated/dataModel';
import type { InboxState } from '$convex/lib/inboxState';

const INBOX_PAGE_SIZE = 10;

export function normalizeRepositoryKeys(repositoryKeys: string[]): string[] {
	return [...repositoryKeys].sort().filter((key, index, sorted) => key !== sorted[index - 1]);
}

type InboxSectionInput = {
	state: InboxState;
	enabled: boolean;
	sectionOpen: boolean;
	repositoryKeys: string[];
};

function useInboxSection(input: InboxSectionInput): InboxSectionData {
	const query = usePaginatedQueryResult({
		query: api.inbox.list,
		args:
			input.enabled && input.sectionOpen && input.repositoryKeys.length > 0
				? { state: input.state, repositoryKeys: input.repositoryKeys }
				: 'skip',
		initialNumItems: INBOX_PAGE_SIZE
	});
	return {
		state: input.state,
		rows: query.data ?? [],
		loading: query.isLoading,
		canLoadMore: query.canLoadMore,
		error: query.error?.message,
		loadMore: () => query.loadMore(INBOX_PAGE_SIZE)
	};
}

export function useThreadInbox(input: {
	enabled: () => boolean;
	projects: () => string[];
	settledOpen: () => boolean;
}): { sections: InboxSectionData[] } {
	const sectionInput = {
		enabled: input.enabled(),
		settledOpen: input.settledOpen(),
		repositoryKeys: normalizeRepositoryKeys(input.projects())
	};
	// Not a loop: one hook call per inbox state, in a fixed order.
	const unsettled = useInboxSection({ state: 'unsettled', sectionOpen: true, ...sectionInput });
	const settled = useInboxSection({
		state: 'settled',
		sectionOpen: sectionInput.settledOpen,
		...sectionInput
	});
	return { sections: [unsettled, settled] };
}

export type InboxSectionData = {
	state: InboxState;
	rows: Doc<'threadRecords'>[];
	loading: boolean;
	canLoadMore: boolean;
	error?: string;
	loadMore: () => void;
};
