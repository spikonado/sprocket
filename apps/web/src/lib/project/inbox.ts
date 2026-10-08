import {
	usePaginatedQuery_experimental as usePaginatedQueryResult,
	type UsePaginatedQueryObjectReturnType,
	type UsePaginatedQueryOptions
} from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import type { InboxState } from '@convex/lib/inboxState';
import { useRevealPaginatedThread } from '$lib/project/useThreadTree';

const INBOX_PAGE_SIZE = 10;

export type InboxQueryOptions = UsePaginatedQueryOptions<typeof api.inbox.list>;

export type InboxQueryResult = UsePaginatedQueryObjectReturnType<typeof api.inbox.list>;

export type InboxQueryHook = (options: InboxQueryOptions) => InboxQueryResult;

export function normalizeRepositoryKeys(repositoryKeys: string[]): string[] {
	return [...new Set(repositoryKeys)].sort();
}

type InboxSectionInput = {
	state: InboxState;
	enabled: boolean;
	sectionOpen: boolean;
	repositoryKeys: string[];
};

function useInboxSection(input: InboxSectionInput, queryHook: InboxQueryHook): InboxSectionData {
	const query = queryHook({
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

type InboxInput = {
	enabled: boolean;
	repositoryKeys: string[];
	settledOpen: boolean;
};

export function useThreadInbox(
	input: InboxInput,
	queryHook: InboxQueryHook = usePaginatedQueryResult
) {
	const sectionInput = {
		enabled: input.enabled,
		repositoryKeys: normalizeRepositoryKeys(input.repositoryKeys)
	};

	const unsettled = useInboxSection(
		{ state: 'unsettled', sectionOpen: true, ...sectionInput },
		queryHook
	);

	const settled = useInboxSection(
		{
			state: 'settled',
			sectionOpen: input.settledOpen,
			...sectionInput
		},
		queryHook
	);

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

export function useRevealInboxThread(
	root: Doc<'threadRecords'> | null,
	repositoryKeys: readonly string[],
	sections: readonly InboxSectionData[]
): Doc<'threadRecords'> | null {
	const visibleRoot = root && repositoryKeys.includes(root.repositoryKey) ? root : null;
	const emptyPage = { rows: [], loading: false, canLoadMore: false, loadMore: () => {} };

	const state = visibleRoot?.archivedAt === undefined ? 'unsettled' : 'settled';

	useRevealPaginatedThread(
		visibleRoot?._id ?? null,
		sections.find((section) => section.state === state) ?? emptyPage
	);

	return visibleRoot;
}
