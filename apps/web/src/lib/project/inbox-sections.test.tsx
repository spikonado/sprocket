import { renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { Doc, Id } from '$convex/_generated/dataModel';
import {
	useThreadInbox,
	type InboxQueryHook,
	type InboxQueryOptions,
	type InboxQueryResult
} from '$lib/project/inbox';

type ThreadRecord = Doc<'threadRecords'>;

function threadRecord(): ThreadRecord {
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
		data?: ThreadRecord[];
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

function inboxQueryFixture(
	resolve: (options: InboxQueryOptions) => InboxQueryResult = () => inboxQuery()
) {
	const calls: InboxQueryOptions[] = [];
	const hook: InboxQueryHook = (options) => {
		calls.push(options);
		return resolve(options);
	};
	return { hook, calls };
}

it('requests both sections with normalized repositories when enabled', () => {
	const fixture = inboxQueryFixture();
	renderHook(() =>
		useThreadInbox(
			{
				enabled: () => true,
				projects: () => ['zeta', 'alpha', 'zeta'],
				settledOpen: () => true
			},
			fixture.hook
		)
	);

	expect(fixture.calls).toHaveLength(2);
	expect(fixture.calls.map((call) => call.args)).toEqual([
		{ state: 'unsettled', repositoryKeys: ['alpha', 'zeta'] },
		{ state: 'settled', repositoryKeys: ['alpha', 'zeta'] }
	]);
	expect(fixture.calls[0]).toMatchObject({ initialNumItems: 10 });
});

it('skips the settled section until it is opened', () => {
	const fixture = inboxQueryFixture();
	renderHook(() =>
		useThreadInbox(
			{ enabled: () => true, projects: () => ['alpha'], settledOpen: () => false },
			fixture.hook
		)
	);

	expect(fixture.calls.map((call) => call.args)).toEqual([
		{ state: 'unsettled', repositoryKeys: ['alpha'] },
		'skip'
	]);
});

it('skips every section while disabled or without attached projects', () => {
	const disabled = inboxQueryFixture();
	renderHook(() =>
		useThreadInbox(
			{ enabled: () => false, projects: () => ['alpha'], settledOpen: () => true },
			disabled.hook
		)
	);
	expect(disabled.calls.map((call) => call.args)).toEqual(['skip', 'skip']);

	const noProjects = inboxQueryFixture();
	renderHook(() =>
		useThreadInbox(
			{ enabled: () => true, projects: () => [], settledOpen: () => true },
			noProjects.hook
		)
	);
	expect(noProjects.calls.map((call) => call.args)).toEqual(['skip', 'skip']);
});

it('maps query state into sections, preserving errors and pagination', () => {
	const loadMoreCalls: number[] = [];
	const rows = [threadRecord()];
	const fixture = inboxQueryFixture((options) =>
		options.args !== 'skip' && options.args.state === 'unsettled'
			? inboxQuery({
					data: rows,
					canLoadMore: true,
					loadMore: (numItems) => {
						loadMoreCalls.push(numItems);
					}
				})
			: inboxQuery({ error: new Error('Inbox query failed.') })
	);

	const { result } = renderHook(() =>
		useThreadInbox(
			{ enabled: () => true, projects: () => ['alpha'], settledOpen: () => true },
			fixture.hook
		)
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
	expect(loadMoreCalls).toEqual([10]);
	expect(settled.error).toBe('Inbox query failed.');
});
