import { describe, expect, it } from 'vitest';

import { api } from '@convex/_generated/api';
import {
	createQueuedRun,
	initConvexTest,
	seedOwnedThread,
	type ConvexTestInstance
} from '@convex/test.setup';

const pr = (
	number: number,
	state: 'open' | 'closed' | 'merged',
	repository = 'github.com/acme/widgets',
	title = `PR ${number}`
) => ({ repository, number, state, title });

async function startRun(t: ConvexTestInstance) {
	const { asUser, threadId } = await seedOwnedThread(t);
	const executionSecret = 'pr-secret';
	const created = await createQueuedRun(t, asUser, threadId, 'pr-run', executionSecret);
	const claimId = 'pr-claim';

	await t.mutation(api.agentRuntime.start, { runId: created.runId, claimId, executionSecret });

	return { asUser, threadId, caller: { runId: created.runId, claimId, executionSecret } };
}

describe('linked pull requests', () => {
	it('adds new links after earlier ones and updates relinked PRs in place', async () => {
		const t = initConvexTest();
		const { threadId, caller } = await startRun(t);

		await t.mutation(api.pullRequests.link, { ...caller, pullRequests: [pr(12, 'open')] });

		const linked = await t.mutation(api.pullRequests.link, {
			...caller,
			pullRequests: [pr(7, 'merged'), pr(12, 'closed'), pr(12, 'open', 'github.com/acme/site')]
		});

		expect(linked).toEqual([
			pr(12, 'closed'),
			pr(7, 'merged'),
			pr(12, 'open', 'github.com/acme/site')
		]);
		const thread = await t.run((ctx) => ctx.db.get('threadRecords', threadId));
		expect(thread?.pullRequests).toEqual(linked);
	});

	it('updates only states and titles of PRs linked to threads the user owns', async () => {
		const t = initConvexTest();
		const { asUser, threadId, caller } = await startRun(t);

		await t.mutation(api.pullRequests.link, {
			...caller,
			pullRequests: [pr(3, 'open'), pr(12, 'open'), pr(12, 'open', 'github.com/acme/site')]
		});

		await asUser.mutation(api.pullRequests.updateStates, {
			updates: [
				{ threadId, ...pr(3, 'closed') },
				{ threadId, ...pr(12, 'merged') },
				{ threadId, ...pr(12, 'open', 'github.com/acme/site', 'Renamed') },
				{ threadId, ...pr(99, 'open') }
			]
		});

		const thread = await t.run((ctx) => ctx.db.get('threadRecords', threadId));
		expect(thread?.pullRequests).toEqual([
			pr(3, 'closed'),
			pr(12, 'merged'),
			pr(12, 'open', 'github.com/acme/site', 'Renamed')
		]);
		await expect(
			t.withIdentity({ subject: 'user_bob' }).mutation(api.pullRequests.updateStates, {
				updates: [{ threadId, ...pr(3, 'open') }]
			})
		).rejects.toThrow(/not found/i);
	});

	it('caps links per thread', async () => {
		const t = initConvexTest();
		const { caller } = await startRun(t);

		await expect(
			t.mutation(api.pullRequests.link, {
				...caller,
				pullRequests: Array.from({ length: 21 }, (_, index) => pr(index + 1, 'open'))
			})
		).rejects.toThrow(/at most 20 PRs/);
	});
});
