import { renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Doc } from '$convex/_generated/dataModel';
import type { PaginatedQueryArgs } from 'convex/react';
import { api } from '$convex/_generated/api';
import { useThreadInbox } from '$lib/project/inbox';

const usePaginatedQueryResult = vi.fn();

vi.mock('convex/react', () => ({
	usePaginatedQuery_experimental: (options: unknown) => usePaginatedQueryResult(options)
}));

type InboxArgs = PaginatedQueryArgs<typeof api.inbox.list>;

function sectionResult(overrides: Record<string, unknown> = {}) {
	return {
		data: [],
		status: 'success',
		canLoadMore: false,
		isLoading: false,
		error: undefined,
		loadMore: vi.fn(),
		...overrides
	};
}

beforeEach(() => {
	usePaginatedQueryResult.mockReset();
	usePaginatedQueryResult.mockImplementation(() => sectionResult());
});

it('requests both sections with normalized repositories when enabled', () => {
	renderHook(() =>
		useThreadInbox({
			enabled: () => true,
			projects: () => ['zeta', 'alpha', 'zeta'],
			settledOpen: () => true
		})
	);

	expect(usePaginatedQueryResult).toHaveBeenCalledTimes(2);
	const args = usePaginatedQueryResult.mock.calls.map(
		([options]) => (options as { args: InboxArgs | 'skip' }).args
	);
	expect(args).toEqual([
		{ state: 'unsettled', repositoryKeys: ['alpha', 'zeta'] },
		{ state: 'settled', repositoryKeys: ['alpha', 'zeta'] }
	]);
	expect(usePaginatedQueryResult.mock.calls[0][0]).toMatchObject({ initialNumItems: 10 });
});

it('skips the settled section until it is opened', () => {
	renderHook(() =>
		useThreadInbox({
			enabled: () => true,
			projects: () => ['alpha'],
			settledOpen: () => false
		})
	);

	const args = usePaginatedQueryResult.mock.calls.map(
		([options]) => (options as { args: InboxArgs | 'skip' }).args
	);
	expect(args).toEqual([{ state: 'unsettled', repositoryKeys: ['alpha'] }, 'skip']);
});

it('skips every section while disabled or without attached projects', () => {
	renderHook(() =>
		useThreadInbox({ enabled: () => false, projects: () => ['alpha'], settledOpen: () => true })
	);
	expect(
		usePaginatedQueryResult.mock.calls.map(
			([options]) => (options as { args: InboxArgs | 'skip' }).args
		)
	).toEqual(['skip', 'skip']);

	usePaginatedQueryResult.mockClear();
	renderHook(() =>
		useThreadInbox({ enabled: () => true, projects: () => [], settledOpen: () => true })
	);
	expect(
		usePaginatedQueryResult.mock.calls.map(
			([options]) => (options as { args: InboxArgs | 'skip' }).args
		)
	).toEqual(['skip', 'skip']);
});

it('maps query state into sections, preserving errors and pagination', () => {
	const loadMore = vi.fn();
	const rows = [{ _id: 'thread-1' } as unknown as Doc<'threadRecords'>];
	usePaginatedQueryResult.mockImplementation(({ args }: { args: InboxArgs | 'skip' }) =>
		args !== 'skip' && args.state === 'unsettled'
			? sectionResult({ data: rows, canLoadMore: true, loadMore })
			: sectionResult({ status: 'error', error: new Error('Inbox query failed.') })
	);

	const { result } = renderHook(() =>
		useThreadInbox({ enabled: () => true, projects: () => ['alpha'], settledOpen: () => true })
	);

	const [unsettled, settled] = result.current.sections;
	expect(unsettled).toMatchObject({
		state: 'unsettled',
		rows,
		loading: false,
		canLoadMore: true,
		error: undefined
	});
	unsettled.loadMore();
	expect(loadMore).toHaveBeenCalledWith(10);
	expect(settled.error).toBe('Inbox query failed.');
});
