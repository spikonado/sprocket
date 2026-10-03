import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Id } from '@convex/_generated/dataModel';
import {
	useExpandedThreads,
	useRevealPaginatedThread,
	type ThreadChildrenData
} from '$lib/project/useThreadTree';

type RevealPage = Pick<ThreadChildrenData, 'loading' | 'canLoadMore' | 'error' | 'loadMore'> & {
	rows: { _id: Id<'threadRecords'> }[];
};

type RevealProps = { selectedId: Id<'threadRecords'> | null; page: RevealPage };

beforeEach(() => {
	localStorage.clear();
});

function id(value: string) {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return value as Id<'threadRecords'>;
}

it('loads successive pages until the selected branch becomes visible', () => {
	const loadMore = vi.fn();
	const firstPage = Array.from({ length: 20 }, (_, index) => ({ _id: id(`child-${index}`) }));
	const page = { rows: firstPage, loading: false, canLoadMore: true, loadMore };

	const { rerender } = renderHook(
		({ selectedId, page }) => useRevealPaginatedThread(selectedId, page),
		{ initialProps: { selectedId: id('selected-grandchild'), page } }
	);

	expect(loadMore).toHaveBeenCalledTimes(1);
	rerender({ selectedId: id('selected-grandchild'), page: { ...page } });
	expect(loadMore).toHaveBeenCalledTimes(1);
	rerender({ selectedId: id('selected-grandchild'), page: { ...page, loading: true } });
	expect(loadMore).toHaveBeenCalledTimes(1);
	const secondPage = [...firstPage, { _id: id('other-child') }];
	rerender({ selectedId: id('selected-grandchild'), page: { ...page, rows: secondPage } });
	expect(loadMore).toHaveBeenCalledTimes(2);
	rerender({
		selectedId: id('selected-grandchild'),
		page: { ...page, rows: [...secondPage, { _id: id('selected-grandchild') }] }
	});
	expect(loadMore).toHaveBeenCalledTimes(2);
	rerender({ selectedId: id('another-child'), page });
	expect(loadMore).toHaveBeenCalledTimes(3);
});

it('waits for a usable page and keeps unrelated branches manually paginated', () => {
	const loadMore = vi.fn();

	const page: RevealPage = { rows: [], loading: false, canLoadMore: true, loadMore };
	const initialProps: RevealProps = { selectedId: null, page };

	const { rerender } = renderHook(
		({ selectedId, page }: RevealProps) => useRevealPaginatedThread(selectedId, page),
		{ initialProps }
	);

	expect(loadMore).toHaveBeenCalledTimes(0);
	rerender({ selectedId: id('selected'), page: { ...page, error: 'Offline' } });
	expect(loadMore).toHaveBeenCalledTimes(0);
	rerender({ selectedId: id('selected'), page: { ...page, canLoadMore: false } });
	expect(loadMore).toHaveBeenCalledTimes(0);
	rerender({ selectedId: id('selected'), page });
	expect(loadMore).toHaveBeenCalledTimes(1);
});

it('starts collapsed and remembers expansion locally', () => {
	const { result } = renderHook(() => useExpandedThreads('alice'));

	expect(result.current.isExpanded(id('root'))).toBe(false);

	act(() => result.current.expand(id('root')));

	expect(result.current.isExpanded(id('root'))).toBe(true);
	expect(localStorage.getItem('sprocket.inbox.expanded-threads:alice')).toBe('["root"]');

	const remembered = renderHook(() => useExpandedThreads('alice'));

	expect(remembered.result.current.isExpanded(id('root'))).toBe(true);
});

it('collapses a whole branch through the known tree', () => {
	const { result } = renderHook(() => useExpandedThreads('alice'));

	act(() => {
		result.current.expand(id('root'));
		result.current.expand(id('child'));
		result.current.expand(id('grandchild'));
		result.current.expand(id('sibling'));
		result.current.registerChildren(id('root'), [{ _id: id('child') }, { _id: id('sibling') }]);
		result.current.registerChildren(id('child'), [{ _id: id('grandchild') }]);
	});

	act(() => result.current.collapse(id('child')));

	expect(result.current.isExpanded(id('root'))).toBe(true);
	expect(result.current.isExpanded(id('child'))).toBe(false);
	expect(result.current.isExpanded(id('grandchild'))).toBe(false);
	expect(result.current.isExpanded(id('sibling'))).toBe(true);
	expect(localStorage.getItem('sprocket.inbox.expanded-threads:alice')).toBe('["root","sibling"]');
});

it('reveals ancestors and keeps expansion storage scoped per signed-in user', () => {
	const { result, rerender } = renderHook(({ user }) => useExpandedThreads(user), {
		// SAFETY: fixture strings are only compared as opaque user keys.
		initialProps: { user: 'alice' as string | null }
	});

	act(() => result.current.revealAncestors([id('root'), id('child')]));

	expect(result.current.isExpanded(id('root'))).toBe(true);
	expect(result.current.isExpanded(id('child'))).toBe(true);
	expect(localStorage.getItem('sprocket.inbox.expanded-threads:alice')).toBe('["root","child"]');

	rerender({ user: 'bob' });

	expect(result.current.isExpanded(id('root'))).toBe(false);
	expect(localStorage.getItem('sprocket.inbox.expanded-threads:bob')).toBeNull();

	act(() => result.current.expand(id('other')));

	expect(localStorage.getItem('sprocket.inbox.expanded-threads:bob')).toBe('["other"]');
	expect(localStorage.getItem('sprocket.inbox.expanded-threads:alice')).toBe('["root","child"]');
});
