import { expect, it, vi } from 'vitest';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { PullRequestRefresher, type PullRequestStateSync } from '$lib/project/pullRequestRefresh';

type PullRequests = NonNullable<Doc<'threadRecords'>['pullRequests']>;

const pr = (
	number: number,
	state: PullRequests[number]['state'],
	repositoryKey = 'github.com/acme/widgets'
) => ({ repositoryKey, number, state });

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
		pullRequests.map((pr) => ({ ...pr, state: 'merged' as const }))
	);

	const updateStates = vi.fn<PullRequestStateSync['updateStates']>(async () => null);

	return { fetchStates, updateStates };
}

const requested = (sync: ReturnType<typeof fakeSync>) =>
	sync.fetchStates.mock.calls.map(([pullRequests]) => pullRequests.map((pr) => pr.number));

it('reads non-merged PRs from their own repositories as threads appear and records changed states', async () => {
	const sync = fakeSync();
	const refresher = new PullRequestRefresher(sync);

	const a = thread('a', [pr(1, 'open'), pr(2, 'merged'), pr(3, 'closed', 'github.com/acme/site')]);

	refresher.show('sidebar', [a]);
	refresher.show('sidebar', [a]);
	await vi.waitFor(() => expect(sync.updateStates).toHaveBeenCalled());

	expect(sync.fetchStates.mock.calls).toEqual([
		[
			[
				{ repositoryKey: 'github.com/acme/widgets', number: 1 },
				{ repositoryKey: 'github.com/acme/site', number: 3 }
			]
		]
	]);
	expect(sync.updateStates).toHaveBeenCalledWith([
		{ threadId: 'a', ...pr(1, 'merged') },
		{ threadId: 'a', ...pr(3, 'merged', 'github.com/acme/site') }
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
