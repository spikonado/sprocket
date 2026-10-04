import { useEffect, useMemo, useRef, useState } from 'react';
import {
	usePaginatedQuery_experimental as usePaginatedQueryResult,
	useQuery_experimental as useQueryResult
} from 'convex/react';
import { z } from 'zod';
import { api } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { collapseThreadBranch } from '$lib/project/subagents';

function expandedThreadsStorageKey(userKey: string): string {
	return `sprocket.inbox.expanded-threads:${userKey}`;
}

export const THREAD_CHILDREN_PAGE_SIZE = 20;

export type ThreadTreeSummary = {
	descendantCount: number;
	anyActive: boolean;
	descendantsActive: boolean;
};

export type ThreadChildrenData = {
	rows: Doc<'threadRecords'>[];
	loading: boolean;
	canLoadMore: boolean;
	error?: string;
	loadMore: () => void;
};

export type ThreadTreeSummaryRead = (args: {
	threadId: Id<'threadRecords'> | null;
	enabled: boolean;
}) => ThreadTreeSummary | undefined;

export function useRevealPaginatedThread(
	threadId: Id<'threadRecords'> | null,
	page: Pick<ThreadChildrenData, 'loading' | 'canLoadMore' | 'error' | 'loadMore'> & {
		rows: readonly Pick<Doc<'threadRecords'>, '_id'>[];
	}
) {
	const requestedRef = useRef<{
		threadId: Id<'threadRecords'>;
		rows: typeof page.rows;
	} | null>(null);

	const { rows, loading, canLoadMore, error, loadMore } = page;

	useEffect(() => {
		if (!threadId || loading || error || !canLoadMore || rows.some((row) => row._id === threadId)) {
			return;
		}

		if (requestedRef.current?.threadId === threadId && requestedRef.current.rows === rows) return;
		requestedRef.current = { threadId, rows };
		loadMore();
	}, [threadId, rows, loading, canLoadMore, error, loadMore]);
}

export function useThreadChildren(parentId: Id<'threadRecords'>): ThreadChildrenData {
	const query = usePaginatedQueryResult({
		query: api.threads.listChildren,
		args: { threadId: parentId },
		initialNumItems: THREAD_CHILDREN_PAGE_SIZE
	});

	return {
		rows: query.data ?? [],
		loading: query.isLoading,
		canLoadMore: query.canLoadMore,
		error: query.error?.message,
		loadMore: () => query.loadMore(THREAD_CHILDREN_PAGE_SIZE)
	};
}

export function useThreadTreeSummary({
	threadId,
	enabled
}: {
	threadId: Id<'threadRecords'> | null;
	enabled: boolean;
}): ThreadTreeSummary | undefined {
	const result = useQueryResult({
		query: api.threads.subtreeSummaryForThread,
		args: enabled && threadId ? { threadId } : 'skip'
	});

	return result.status === 'success' ? result.data : undefined;
}

function useThreadAncestry(
	threadId: Id<'threadRecords'> | null
): Id<'threadRecords'>[] | undefined {
	const result = useQueryResult({
		query: api.threads.ancestorChain,
		args: threadId ? { threadId } : 'skip'
	});

	return result.status === 'success' ? result.data : undefined;
}

function readStoredExpandedThreadIds(userKey: string): string[] {
	try {
		const stored = localStorage.getItem(expandedThreadsStorageKey(userKey));
		const parsed = stored ? z.array(z.string()).safeParse(JSON.parse(stored)) : null;

		return parsed?.success ? parsed.data : [];
	} catch {
		return [];
	}
}

function storeExpandedThreadIds(userKey: string, expandedThreadIds: readonly string[]) {
	try {
		localStorage.setItem(expandedThreadsStorageKey(userKey), JSON.stringify(expandedThreadIds));
	} catch {
		// Browsers can deny storage access while still allowing the app to run.
	}
}

export function useExpandedThreads(userKey: string | null) {
	const [expandedThreadIds, setExpandedThreadIds] = useState<string[]>([]);
	const loadedForRef = useRef<string | null>(null);

	const knownThreadsRef = useRef(
		new Map<
			Id<'threadRecords'>,
			{ _id: Id<'threadRecords'>; parentThreadId?: Id<'threadRecords'> }
		>()
	);

	useEffect(() => {
		if (loadedForRef.current === userKey) return;
		loadedForRef.current = userKey;
		setExpandedThreadIds(userKey ? readStoredExpandedThreadIds(userKey) : []);
	}, [userKey]);

	const persist = (next: string[]) => {
		if (userKey) storeExpandedThreadIds(userKey, next);
	};

	return {
		isExpanded: (threadId: Id<'threadRecords'>) => expandedThreadIds.includes(threadId),
		expand: (threadId: Id<'threadRecords'>) => {
			setExpandedThreadIds((current) => {
				if (current.includes(threadId)) return current;
				const next = [...current, threadId];
				persist(next);

				return next;
			});
		},
		revealAncestors: (ancestorIds: readonly Id<'threadRecords'>[]) => {
			if (ancestorIds.length === 0) return;
			setExpandedThreadIds((current) => {
				const next = [...new Set([...current, ...ancestorIds])];

				if (next.length !== current.length) persist(next);

				return next;
			});
		},
		registerChildren: (
			parentId: Id<'threadRecords'>,
			children: readonly Pick<Doc<'threadRecords'>, '_id'>[]
		) => {
			const known = knownThreadsRef.current;

			for (const child of children) {
				known.set(child._id, { _id: child._id, parentThreadId: parentId });
			}
		},
		collapse: (threadId: Id<'threadRecords'>) => {
			setExpandedThreadIds((current) => {
				if (!current.includes(threadId)) return current;
				const next = collapseThreadBranch(current, threadId, [...knownThreadsRef.current.values()]);
				persist(next);

				return next;
			});
		}
	};
}

export type UseExpandedThreads = ReturnType<typeof useExpandedThreads>;

export function useSelectedThreadAncestryReveal({
	currentThreadId,
	enabled,
	expansion
}: {
	currentThreadId: Id<'threadRecords'> | null;
	enabled: boolean;
	expansion: UseExpandedThreads;
}) {
	const ancestry = useThreadAncestry(enabled ? currentThreadId : null);
	const reveal = expansion.revealAncestors;
	const revealedKeyRef = useRef<string | null>(null);

	useEffect(() => {
		if (!currentThreadId || !ancestry || ancestry.length === 0) {
			revealedKeyRef.current = null;

			return;
		}

		const revealKey = `${currentThreadId}:${ancestry.join(',')}`;

		if (revealedKeyRef.current === revealKey) return;
		revealedKeyRef.current = revealKey;
		reveal(ancestry);
	}, [currentThreadId, ancestry, reveal]);

	return useMemo(
		() => (enabled && currentThreadId && ancestry ? [...ancestry, currentThreadId] : []),
		[enabled, currentThreadId, ancestry]
	);
}
