import { renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { useThreadInbox, type InboxQueryHook, type InboxQueryResult } from '$lib/project/inbox';

function threadRecord(): Doc<'threadRecords'> {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return {
		_id: 'thread-1' as Id<'threadRecords'>,
		_creationTime: 1,
		userId: 'user-a',
		repositoryKey: 'alpha',
		submissionId: 'submission-1',
		selectedModel: 'model',
		reasoningEffort: 'high' as const,
		fastMode: false,
		title: 'Thread',
		lastMessageAt: 1,
		status: 'completed'
	};
}

function inboxQuery(
	overrides: {
		data?: Doc<'threadRecords'>[];
		canLoadMore?: boolean;
		error?: Error;
		loadMore?: (numItems: number) => void;
	} = {}
): InboxQueryResult {
	const loadMore = overrides.loadMore ?? (() => {});

	if (overrides.error) {
		return {
			data: overrides.data ?? [],
			status: 'error',
			canLoadMore: false,
			isLoading: false,
			error: overrides.error,
			loadMore
		};
	}

	return {
		data: overrides.data ?? [],
		status: 'success',
		canLoadMore: overrides.canLoadMore ?? false,
		isLoading: false,
		error: undefined,
		loadMore
	};
}

it('requests both sections with normalized repositories when enabled', () => {
	const query = vi.fn<InboxQueryHook>(() => inboxQuery());
	renderHook(() =>
		useThreadInbox(
			{
				enabled: true,
				repositoryKeys: ['zeta', 'alpha', 'zeta'],
				settledOpen: true
			},
			query
		)
	);

	expect(query.mock.calls.map(([call]) => call.args)).toEqual([
		{ state: 'unsettled', repositoryKeys: ['alpha', 'zeta'] },
		{ state: 'settled', repositoryKeys: ['alpha', 'zeta'] }
	]);
});

it('requests the settled section when it is opened', () => {
	const query = vi.fn<InboxQueryHook>(() => inboxQuery());

	const { rerender } = renderHook(
		(settledOpen) =>
			useThreadInbox({ enabled: true, repositoryKeys: ['alpha'], settledOpen }, query),
		{ initialProps: false }
	);

	expect(query.mock.calls.map(([call]) => call.args)).toEqual([
		{ state: 'unsettled', repositoryKeys: ['alpha'] },
		'skip'
	]);
	query.mockClear();
	rerender(true);
	expect(query.mock.calls.map(([call]) => call.args)).toEqual([
		{ state: 'unsettled', repositoryKeys: ['alpha'] },
		{ state: 'settled', repositoryKeys: ['alpha'] }
	]);
});

it.each([
	{ enabled: false, repositoryKeys: ['alpha'] },
	{ enabled: true, repositoryKeys: [] }
])('skips every section with $enabled enabled and $repositoryKeys repositories', (input) => {
	const query = vi.fn<InboxQueryHook>(() => inboxQuery());
	renderHook(() => useThreadInbox({ ...input, settledOpen: true }, query));
	expect(query.mock.calls.map(([call]) => call.args)).toEqual(['skip', 'skip']);
});

it('maps query state into sections, preserving errors and pagination', () => {
	const loadMore = vi.fn<(numItems: number) => void>();
	const rows = [threadRecord()];

	const query = vi.fn<InboxQueryHook>((options) =>
		options.args !== 'skip' && options.args.state === 'unsettled'
			? inboxQuery({
					data: rows,
					canLoadMore: true,
					loadMore
				})
			: inboxQuery({ error: new Error('Inbox query failed.') })
	);

	const { result } = renderHook(() =>
		useThreadInbox({ enabled: true, repositoryKeys: ['alpha'], settledOpen: true }, query)
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
	expect(loadMore).toHaveBeenCalledExactlyOnceWith(10);
	expect(settled.error).toBe('Inbox query failed.');
});
