import { renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Doc, Id } from '@convex/_generated/dataModel';
import {
	PullRequestRefresher,
	type PullRequestStateSync,
	usePullRequestRefresher
} from '$lib/project/pullRequestRefresh';

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

type PullRequests = NonNullable<Doc<'threadRecords'>['pullRequests']>;

const pr = (
	number: number,
	state: PullRequests[number]['state'],
	repository = 'github.com/acme/widgets',
	title = `PR ${number}`
) => ({ repository, number, state, title });

function thread(id: string, pullRequests: PullRequests): Doc<'threadRecords'> {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return {
		_id: id as Id<'threadRecords'>,
		_creationTime: 1,
		userId: 'user-a',
		repositoryKey: 'github.com/acme/widgets',
		submissionId: `submission-${id}`,
		selectedModel: 'model',
		reasoningEffort: 'high' as const,
		fastMode: false,
		title: id,
		lastMessageAt: 1,
		status: 'completed',
		pullRequests
	};
}

function fakeSync() {
	const fetchStates = vi.fn<PullRequestStateSync['fetchStates']>(async (pullRequests) =>
		pullRequests.map((pr) => ({ ...pr, state: 'merged' as const, title: `PR ${pr.number}` }))
	);

	const updateStates = vi.fn<PullRequestStateSync['updateStates']>(async () => null);

	return { fetchStates, updateStates };
}

const requested = (sync: ReturnType<typeof fakeSync>) =>
	sync.fetchStates.mock.calls.map(([pullRequests]) => pullRequests.map((pr) => pr.number));

it('reads non-merged PRs of threads as they appear and records changed states and titles', async () => {
	const sync = fakeSync();

	sync.fetchStates.mockImplementationOnce(async () => [
		pr(1, 'merged'),
		pr(3, 'closed', 'github.com/acme/site', 'Renamed'),
		pr(4, 'open')
	]);
	const refresher = new PullRequestRefresher(sync);

	const a = thread('a', [
		pr(1, 'open'),
		pr(2, 'merged'),
		pr(3, 'closed', 'github.com/acme/site'),
		pr(4, 'open')
	]);

	refresher.show('sidebar', [a]);
	refresher.show('sidebar', [a]);
	await vi.waitFor(() => expect(sync.updateStates).toHaveBeenCalled());

	expect(sync.fetchStates.mock.calls).toEqual([
		[
			[
				{ repository: 'github.com/acme/widgets', number: 1 },
				{ repository: 'github.com/acme/site', number: 3 },
				{ repository: 'github.com/acme/widgets', number: 4 }
			]
		]
	]);
	expect(sync.updateStates).toHaveBeenCalledWith([
		{ threadId: 'a', ...pr(1, 'merged') },
		{ threadId: 'a', ...pr(3, 'closed', 'github.com/acme/site', 'Renamed') }
	]);
});

it('re-reads every shown thread on refreshShown and a thread that comes back into view', () => {
	const sync = fakeSync();
	const refresher = new PullRequestRefresher(sync);
	const a = thread('a', [pr(1, 'open')]);
	const b = thread('b', [pr(2, 'open')]);

	refresher.show('sidebar', [a]);
	refresher.show('selected', [b]);
	refresher.refreshShown();
	refresher.show('sidebar', []);
	refresher.show('sidebar', [a]);
	refresher.hide('selected');
	refresher.refreshShown();

	expect(requested(sync)).toEqual([[1], [2], [1, 2], [1], [1]]);
});

it('reads closed PRs at most every 15 minutes and open PRs on every refresh', async () => {
	vi.useFakeTimers();
	const sync = fakeSync();

	sync.fetchStates.mockImplementation(async (pullRequests) =>
		pullRequests.map((ref) => pr(ref.number, ref.number === 1 ? 'open' : 'closed'))
	);
	const refresher = new PullRequestRefresher(sync);

	refresher.show('sidebar', [thread('a', [pr(1, 'open'), pr(2, 'closed')])]);
	await vi.advanceTimersByTimeAsync(0);
	vi.advanceTimersByTime(14 * 60_000);
	refresher.refreshShown();
	await vi.advanceTimersByTimeAsync(0);
	vi.advanceTimersByTime(60_000);
	refresher.refreshShown();

	expect(requested(sync)).toEqual([[1, 2], [1], [1, 2]]);
});

it('keeps reading a closed PR until GitHub answers for it, separately for each thread', async () => {
	const sync = fakeSync();

	sync.fetchStates.mockImplementationOnce(async () => []);
	sync.fetchStates.mockImplementation(async (pullRequests) =>
		pullRequests.map((ref) => pr(ref.number, 'closed'))
	);
	const refresher = new PullRequestRefresher(sync);
	const a = thread('a', [pr(2, 'closed')]);

	refresher.show('sidebar', [a]);
	await vi.waitFor(() => expect(sync.fetchStates).toHaveBeenCalledTimes(1));
	refresher.refreshShown();
	await vi.waitFor(() => expect(sync.fetchStates).toHaveBeenCalledTimes(2));
	await new Promise((resolve) => setTimeout(resolve, 0));
	refresher.refreshShown();
	refresher.show('selected', [thread('b', [pr(2, 'closed')])]);

	expect(requested(sync)).toEqual([[2], [2], [2]]);
});

it('refreshes each minute only while visible, and on return once a minute has passed', () => {
	vi.useFakeTimers();
	const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');

	const setVisibility = (state: DocumentVisibilityState) => {
		visibility.mockReturnValue(state);
		document.dispatchEvent(new Event('visibilitychange'));
	};

	const sync = fakeSync();
	const { result } = renderHook(() => usePullRequestRefresher(sync));

	result.current!.show('sidebar', [thread('a', [pr(1, 'open')])]);
	vi.advanceTimersByTime(60_000);
	expect(sync.fetchStates).toHaveBeenCalledTimes(2);

	setVisibility('hidden');
	vi.advanceTimersByTime(120_000);
	expect(sync.fetchStates).toHaveBeenCalledTimes(2);

	setVisibility('visible');
	expect(sync.fetchStates).toHaveBeenCalledTimes(3);

	setVisibility('hidden');
	vi.advanceTimersByTime(10_000);
	setVisibility('visible');
	expect(sync.fetchStates).toHaveBeenCalledTimes(3);
});
