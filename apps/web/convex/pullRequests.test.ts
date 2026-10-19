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

		await t.mutation(api.pullRequests.link, {
			...caller,
			pullRequests: [pr(7, 'merged'), pr(12, 'closed'), pr(12, 'open', 'github.com/acme/site')]
		});

		const thread = await t.run((ctx) => ctx.db.get('threadRecords', threadId));
		expect(thread?.pullRequests).toEqual([
			pr(12, 'closed'),
			pr(7, 'merged'),
			pr(12, 'open', 'github.com/acme/site')
		]);
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

	it.each([true, false])(
		'settles a thread once all its PRs merge when the setting is %s',
		async (enabled) => {
			const t = initConvexTest();
			const { asUser, threadId } = await seedOwnedThread(t);

			await asUser.mutation(api.uiPreferences.setSettleMergedThreads, { enabled });
			await t.run((ctx) =>
				ctx.db.patch('threadRecords', threadId, { pullRequests: [pr(1, 'open'), pr(2, 'open')] })
			);

			const archivedAt = async () =>
				(await t.run((ctx) => ctx.db.get('threadRecords', threadId)))?.archivedAt;

			await asUser.mutation(api.pullRequests.updateStates, {
				updates: [{ threadId, ...pr(1, 'merged') }]
			});
			expect(await archivedAt()).toBeUndefined();

			await asUser.mutation(api.pullRequests.updateStates, {
				updates: [{ threadId, ...pr(2, 'merged') }]
			});
			expect((await archivedAt()) !== undefined).toBe(enabled);
		}
	);

	it.each([
		['has active work', true],
		['was unsettled after its PRs merged', false]
	])('leaves a thread unsettled when it %s', async (_, active) => {
		const t = initConvexTest();
		const started = active ? await startRun(t) : await seedOwnedThread(t);
		const { asUser, threadId } = started;

		const merge = (title?: string) =>
			asUser.mutation(api.pullRequests.updateStates, {
				updates: [{ threadId, ...pr(1, 'merged', undefined, title) }]
			});

		await asUser.mutation(api.uiPreferences.setSettleMergedThreads, { enabled: true });
		await t.run((ctx) =>
			ctx.db.patch('threadRecords', threadId, { pullRequests: [pr(1, 'open')] })
		);
		await merge();

		if (!active) {
			await asUser.mutation(api.threads.unsettle, { threadId });
			await merge('Renamed');
		}

		const thread = await t.run((ctx) => ctx.db.get('threadRecords', threadId));
		expect(thread?.archivedAt).toBeUndefined();
		expect(thread?.settleWhenIdle).toBe(active || undefined);
	});

	it('settles after the run finishes when PRs merged while it was still working', async () => {
		const t = initConvexTest();
		const { asUser, threadId, caller } = await startRun(t);

		await asUser.mutation(api.uiPreferences.setSettleMergedThreads, { enabled: true });
		await t.run((ctx) =>
			ctx.db.patch('threadRecords', threadId, { pullRequests: [pr(1, 'open')] })
		);
		await asUser.mutation(api.pullRequests.updateStates, {
			updates: [{ threadId, ...pr(1, 'merged') }]
		});

		expect(await t.run((ctx) => ctx.db.get('threadRecords', threadId))).toMatchObject({
			archivedAt: undefined,
			settleWhenIdle: true
		});

		await t.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: caller.runId,
			expectedClaimId: caller.claimId,
			executionSecret: caller.executionSecret,
			status: 'completed',
			text: 'done'
		});

		const thread = await t.run((ctx) => ctx.db.get('threadRecords', threadId));
		expect(thread?.archivedAt).toBeTypeOf('number');
		expect(thread?.settleWhenIdle).toBeUndefined();
	});

	it('settles after the run finishes when the agent linked already-merged PRs', async () => {
		const t = initConvexTest();
		const { asUser, threadId, caller } = await startRun(t);

		await asUser.mutation(api.uiPreferences.setSettleMergedThreads, { enabled: true });
		await t.mutation(api.pullRequests.link, {
			...caller,
			pullRequests: [pr(1, 'merged')]
		});

		expect(await t.run((ctx) => ctx.db.get('threadRecords', threadId))).toMatchObject({
			archivedAt: undefined,
			settleWhenIdle: true
		});

		await t.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: caller.runId,
			expectedClaimId: caller.claimId,
			executionSecret: caller.executionSecret,
			status: 'completed',
			text: 'done'
		});

		const thread = await t.run((ctx) => ctx.db.get('threadRecords', threadId));
		expect(thread?.archivedAt).toBeTypeOf('number');
		expect(thread?.settleWhenIdle).toBeUndefined();
	});

	it('drops a pending settle if the setting is turned off before the run finishes', async () => {
		const t = initConvexTest();
		const { asUser, threadId, caller } = await startRun(t);

		await asUser.mutation(api.uiPreferences.setSettleMergedThreads, { enabled: true });
		await t.run((ctx) =>
			ctx.db.patch('threadRecords', threadId, { pullRequests: [pr(1, 'open')] })
		);
		await asUser.mutation(api.pullRequests.updateStates, {
			updates: [{ threadId, ...pr(1, 'merged') }]
		});
		await asUser.mutation(api.uiPreferences.setSettleMergedThreads, { enabled: false });
		await t.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: caller.runId,
			expectedClaimId: caller.claimId,
			executionSecret: caller.executionSecret,
			status: 'completed',
			text: 'done'
		});

		const thread = await t.run((ctx) => ctx.db.get('threadRecords', threadId));
		expect(thread?.archivedAt).toBeUndefined();
		expect(thread?.settleWhenIdle).toBeUndefined();
	});
});
