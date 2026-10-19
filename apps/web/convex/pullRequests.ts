import { v } from 'convex/values';
import { mutation, type MutationCtx } from '@convex/_generated/server';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { RUN_NO_LONGER_ACTIVE, toAgentToolConvexError } from '@convex/lib/agentErrors';
import { getExecutionRun, getUserId } from '@convex/lib/auth';
import { ownsActiveRunClaim } from '@convex/lib/runLease';
import { allMerged } from '@convex/lib/pullRequestState';
import { subtreeSummary, threadRunAwaitsAutomaticRecovery } from '@convex/lib/threadHierarchy';
import { getUiPreferences } from '@convex/lib/uiPreferences';
import { vLinkedPullRequest, type LinkedPullRequest } from '@convex/lib/validators';

const MAX_LINKED_PRS = 20;

const pullRequestKey = (pr: { repository: string; number: number }) =>
	`${pr.repository}#${pr.number}`;

async function writeThreadPullRequests(
	ctx: MutationCtx,
	thread: Doc<'threadRecords'>,
	pullRequests: LinkedPullRequest[],
	settleMergedThreads: boolean
) {
	const justMerged = allMerged(pullRequests) && !allMerged(thread.pullRequests ?? []);

	const canSettle =
		justMerged &&
		thread.parentThreadId === undefined &&
		thread.archivedAt === undefined &&
		settleMergedThreads;

	if (!canSettle) {
		if (!allMerged(pullRequests) && thread.settleWhenIdle) {
			await ctx.db.patch('threadRecords', thread._id, {
				pullRequests,
				settleWhenIdle: undefined
			});

			return;
		}

		await ctx.db.patch('threadRecords', thread._id, { pullRequests });

		return;
	}

	if (
		(await subtreeSummary(ctx.db, thread)).anyActive ||
		(await threadRunAwaitsAutomaticRecovery(ctx.db, thread._id))
	) {
		await ctx.db.patch('threadRecords', thread._id, { pullRequests, settleWhenIdle: true });

		return;
	}

	await ctx.db.patch('threadRecords', thread._id, {
		pullRequests,
		archivedAt: Date.now(),
		settleWhenIdle: true
	});
}

/** Adds PRs the agent linked, with the states it read from GitHub on the user's machine. */
export const link = mutation({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string(),
		pullRequests: v.array(vLinkedPullRequest)
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		try {
			const run = await getExecutionRun(ctx, args.runId, args.executionSecret);

			if (!ownsActiveRunClaim(run, args.claimId, Date.now())) throw new Error(RUN_NO_LONGER_ACTIVE);

			const thread = await getOwnedThreadRecord(ctx.db, run.userId, run.threadId);
			const byKey = new Map<string, LinkedPullRequest>();

			for (const pr of [...(thread.pullRequests ?? []), ...args.pullRequests]) {
				byKey.set(pullRequestKey(pr), pr);
			}

			const pullRequests = [...byKey.values()];

			if (pullRequests.length > MAX_LINKED_PRS) {
				throw new Error(`A thread can link at most ${MAX_LINKED_PRS} PRs.`);
			}

			await writeThreadPullRequests(
				ctx,
				thread,
				pullRequests,
				(await getUiPreferences(ctx.db, run.userId))?.settleMergedThreads ?? false
			);

			return null;
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

/** Records what the user's machine read from GitHub for PRs already linked to their threads. */
export const updateStates = mutation({
	args: {
		updates: v.array(
			v.object({
				threadId: v.id('threadRecords'),
				...vLinkedPullRequest.fields
			})
		)
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const byThread = new Map<Id<'threadRecords'>, Map<string, LinkedPullRequest>>();
		let settleMergedThreads: boolean | undefined;

		for (const { threadId, ...pr } of args.updates) {
			const fetched = byThread.get(threadId) ?? new Map();

			fetched.set(pullRequestKey(pr), pr);
			byThread.set(threadId, fetched);
		}

		for (const [threadId, fetched] of byThread) {
			const thread = await getOwnedThreadRecord(ctx.db, userId, threadId);
			const linked = thread.pullRequests ?? [];
			let changed = false;

			const pullRequests = linked.map((pr) => {
				const update = fetched.get(pullRequestKey(pr));

				if (!update || (update.state === pr.state && update.title === pr.title)) return pr;

				changed = true;

				return { ...pr, state: update.state, title: update.title };
			});

			if (!changed) continue;

			settleMergedThreads ??=
				(await getUiPreferences(ctx.db, userId))?.settleMergedThreads ?? false;

			// Only the merge itself settles, so a thread the user unsettles afterwards stays put.
			await writeThreadPullRequests(ctx, thread, pullRequests, settleMergedThreads);
		}

		return null;
	}
});
