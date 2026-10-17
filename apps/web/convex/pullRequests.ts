import { v, type Infer } from 'convex/values';
import { mutation } from '@convex/_generated/server';
import type { Id } from '@convex/_generated/dataModel';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { RUN_NO_LONGER_ACTIVE, toAgentToolConvexError } from '@convex/lib/agentErrors';
import { getExecutionRun, getUserId } from '@convex/lib/auth';
import { ownsActiveRunClaim } from '@convex/lib/runLease';
import { vLinkedPullRequest, vPullRequestState } from '@convex/lib/validators';

type LinkedPullRequest = Infer<typeof vLinkedPullRequest>;

const MAX_LINKED_PRS = 20;

const MAX_STATE_UPDATES = 500;

const pullRequestKey = (pr: { repository: string; number: number }) =>
	`${pr.repository}#${pr.number}`;

/** Adds PRs the agent linked, with the states it read from GitHub on the user's machine. */
export const link = mutation({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string(),
		pullRequests: v.array(vLinkedPullRequest)
	},
	returns: v.array(vLinkedPullRequest),
	handler: async (ctx, args) => {
		try {
			if (!args.pullRequests.every((pr) => Number.isSafeInteger(pr.number) && pr.number > 0)) {
				throw new Error('PR numbers must be positive integers.');
			}

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

			await ctx.db.patch('threadRecords', thread._id, { pullRequests });

			return pullRequests;
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

/** Records states the user's machine read from GitHub for PRs already linked to their threads. */
export const updateStates = mutation({
	args: {
		updates: v.array(
			v.object({
				threadId: v.id('threadRecords'),
				repository: v.string(),
				number: v.number(),
				state: vPullRequestState
			})
		)
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		if (args.updates.length > MAX_STATE_UPDATES) {
			throw new Error(`Update at most ${MAX_STATE_UPDATES} PR states at once.`);
		}

		const userId = await getUserId(ctx);
		const byThread = new Map<Id<'threadRecords'>, Map<string, LinkedPullRequest['state']>>();

		for (const { threadId, state, ...pr } of args.updates) {
			const states = byThread.get(threadId) ?? new Map();

			states.set(pullRequestKey(pr), state);
			byThread.set(threadId, states);
		}

		for (const [threadId, states] of byThread) {
			const thread = await getOwnedThreadRecord(ctx.db, userId, threadId);
			let changed = false;

			const pullRequests = (thread.pullRequests ?? []).map((pr) => {
				const state = states.get(pullRequestKey(pr));

				if (!state || state === pr.state) return pr;

				changed = true;

				return { ...pr, state };
			});

			if (changed) await ctx.db.patch('threadRecords', thread._id, { pullRequests });
		}

		return null;
	}
});
