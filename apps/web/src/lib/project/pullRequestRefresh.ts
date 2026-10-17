import { useEffect, useId, useMemo } from 'react';
import type { Doc, Id } from '@convex/_generated/dataModel';

type Thread = Doc<'threadRecords'>;

type LinkedPullRequest = NonNullable<Thread['pullRequests']>[number];

export type PullRequestRef = { repository: string; number: number };

export type PullRequestStateUpdate = LinkedPullRequest & { threadId: Id<'threadRecords'> };

export type PullRequestStateSync = {
	fetchStates: (pullRequests: PullRequestRef[]) => Promise<LinkedPullRequest[]>;
	updateStates: (updates: PullRequestStateUpdate[]) => Promise<null>;
};

const REFRESH_INTERVAL_MS = 60_000;

const MAX_PULL_REQUESTS_PER_REFRESH = 500;

const refKey = ({ repository, number }: PullRequestRef) => `${repository}#${number}`;

/**
 * Keeps linked PR states and titles of the threads on screen fresh. Each list of shown rows
 * registers itself; a thread is read when it first appears, and every shown
 * thread is read on `refreshShown`. Merged PRs rarely change, so they are skipped.
 */
export class PullRequestRefresher {
	readonly #sync: PullRequestStateSync;
	readonly #lists = new Map<string, readonly Thread[]>();
	#shownIds = new Set<Id<'threadRecords'>>();

	constructor(sync: PullRequestStateSync) {
		this.#sync = sync;
	}

	show(listKey: string, rows: readonly Thread[]) {
		this.#lists.set(listKey, rows);
		const before = this.#shownIds;
		this.#shownIds = new Set(this.#shownThreads().map((thread) => thread._id));
		void this.#refresh(rows.filter((thread) => !before.has(thread._id)));
	}

	hide(listKey: string) {
		this.#lists.delete(listKey);
		this.#shownIds = new Set(this.#shownThreads().map((thread) => thread._id));
	}

	refreshShown() {
		void this.#refresh(this.#shownThreads());
	}

	#shownThreads(): Thread[] {
		const byId = new Map<Id<'threadRecords'>, Thread>();

		for (const rows of this.#lists.values()) {
			for (const thread of rows) byId.set(thread._id, thread);
		}

		return [...byId.values()];
	}

	async #refresh(threads: readonly Thread[]) {
		const linked = threads.flatMap((thread) =>
			(thread.pullRequests ?? []).flatMap((pr) => (pr.state === 'merged' ? [] : [{ thread, pr }]))
		);

		for (let start = 0; start < linked.length; start += MAX_PULL_REQUESTS_PER_REFRESH) {
			const batch = linked.slice(start, start + MAX_PULL_REQUESTS_PER_REFRESH);

			const refs = new Map(
				batch.map(({ pr: { repository, number } }) => [
					refKey({ repository, number }),
					{ repository, number }
				])
			);

			try {
				const fetched = new Map(
					(await this.#sync.fetchStates([...refs.values()])).map((pr) => [refKey(pr), pr])
				);

				const updates = batch.flatMap(({ thread, pr }) => {
					const latest = fetched.get(refKey(pr));

					return latest && (latest.state !== pr.state || latest.title !== pr.title)
						? [
								{
									threadId: thread._id,
									repository: pr.repository,
									number: pr.number,
									state: latest.state,
									title: latest.title
								}
							]
						: [];
				});

				if (updates.length > 0) await this.#sync.updateStates(updates);
			} catch {
				// Stale badges are harmless; the next refresh tries again.
			}
		}
	}
}

/** One refresher per sync source, re-reading every shown thread each minute. */
export function usePullRequestRefresher(
	sync: PullRequestStateSync | null
): PullRequestRefresher | null {
	const refresher = useMemo(() => (sync ? new PullRequestRefresher(sync) : null), [sync]);

	useEffect(() => {
		if (!refresher) return;

		const interval = setInterval(() => refresher.refreshShown(), REFRESH_INTERVAL_MS);

		return () => clearInterval(interval);
	}, [refresher]);

	return refresher;
}

/** Registers rows on screen with the refresher while it is set. */
export function useShownPullRequests(
	refresher: PullRequestRefresher | null,
	rows: readonly Thread[]
) {
	const listKey = useId();

	useEffect(() => {
		if (!refresher) return;

		return () => refresher.hide(listKey);
	}, [refresher, listKey]);

	useEffect(() => {
		refresher?.show(listKey, rows);
	}, [refresher, listKey, rows]);
}

/** Re-reads every shown thread before loading more rows. */
export function refreshOnLoadMore<Section extends { loadMore: () => void }>(
	refresher: PullRequestRefresher | null,
	section: Section
): Section {
	return {
		...section,
		loadMore: () => {
			refresher?.refreshShown();
			section.loadMore();
		}
	};
}
