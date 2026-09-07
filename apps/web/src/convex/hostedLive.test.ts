import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { RUN_CANCELLED_BY_USER, RUN_NO_LONGER_ACTIVE } from '@convex/lib/agentErrors';
import { MAX_LIVE_PARTS, MAX_LIVE_SNAPSHOT_BYTES, type LiveAssistantPart } from './hostedLive';
import {
	createQueuedRun,
	initConvexTest,
	seedOwnedThread,
	type ConvexTestInstance
} from './test.setup';

const claimId = 'claim-live';

type AsUser = ReturnType<ConvexTestInstance['withIdentity']>;

function textPart(text: string, streamId = 'stream-live'): LiveAssistantPart {
	return { type: 'text', id: `${streamId}:text:0`, text, turnId: streamId };
}

async function startLiveRun(
	t: ConvexTestInstance,
	asUser: AsUser,
	threadId: Id<'threadRecords'>,
	executionSecret: string
) {
	const { runId } = await createQueuedRun(
		t,
		asUser,
		threadId,
		`sub-${executionSecret}`,
		executionSecret,
		'Stream a response'
	);
	await asUser.mutation(api.agentRuntime.start, { claimId, runId, executionSecret });
	await asUser.mutation(api.agentRuntime.registerCompletionAttempt, {
		runId,
		claimId,
		attemptSeq: 1,
		executionSecret
	});
	return runId;
}

describe('hostedLive', () => {
	it('returns the live overlay with canonical run status and start time', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'user_live_ok');
		const executionSecret = 'hosted-live-ok';
		const runId = await startLiveRun(t, asUser, threadId, executionSecret);
		const parts = [textPart('Hello')];
		await asUser.mutation(api.hostedLive.publish, {
			runId,
			claimId,
			attemptSeq: 1,
			streamId: 'stream-live',
			sequence: 1,
			text: 'Hello',
			parts,
			executionSecret
		});
		const run = await t.run(async (ctx) => ctx.db.get('runs', runId));
		expect(await asUser.query(api.hostedLive.get, { threadId })).toEqual({
			threadId,
			runId,
			runStatus: 'running',
			streamId: 'stream-live',
			text: 'Hello',
			parts,
			runStartedAt: run?.startedAt
		});
	});

	it('hides the snapshot from another user', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'user_live_owner');
		const executionSecret = 'hosted-live-owner';
		const runId = await startLiveRun(t, asUser, threadId, executionSecret);
		await asUser.mutation(api.hostedLive.publish, {
			runId,
			claimId,
			attemptSeq: 1,
			streamId: 'stream-live',
			sequence: 1,
			text: 'Hello',
			parts: [textPart('Hello')],
			executionSecret
		});
		const other = await seedOwnedThread(t, 'user_live_other');
		await expect(other.asUser.query(api.hostedLive.get, { threadId })).rejects.toThrow(
			'Thread not found.'
		);
	});

	it('rejects a stale claim, attempt, or sequence', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'user_live_stale');
		const executionSecret = 'hosted-live-stale';
		const runId = await startLiveRun(t, asUser, threadId, executionSecret);
		const base = {
			runId,
			claimId,
			attemptSeq: 1,
			streamId: 'stream-live',
			text: 'Hello',
			parts: [textPart('Hello')],
			executionSecret
		};
		await asUser.mutation(api.hostedLive.publish, { ...base, sequence: 1 });

		await expect(asUser.mutation(api.hostedLive.publish, { ...base, sequence: 1 })).rejects.toThrow(
			'Live snapshot sequence is stale.'
		);
		await expect(
			asUser.mutation(api.hostedLive.publish, { ...base, sequence: 2, attemptSeq: 2 })
		).rejects.toThrow('Live snapshot is not for the current completion attempt.');

		await t.run(async (ctx) => {
			await ctx.db.patch('runs', runId, { claimExpiresAt: 1 });
		});
		await expect(asUser.mutation(api.hostedLive.publish, { ...base, sequence: 2 })).rejects.toThrow(
			RUN_NO_LONGER_ACTIVE
		);
	});

	it('rejects publish after cancellation and hides terminal runs', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'user_live_cancel');
		const executionSecret = 'hosted-live-cancel';
		const runId = await startLiveRun(t, asUser, threadId, executionSecret);
		await asUser.mutation(api.hostedLive.publish, {
			runId,
			claimId,
			attemptSeq: 1,
			streamId: 'stream-live',
			sequence: 1,
			text: 'Hello',
			parts: [textPart('Hello')],
			executionSecret
		});
		await t.run(async (ctx) => {
			await ctx.db.patch('runs', runId, { cancellationRequestedAt: Date.now() });
		});
		await expect(
			asUser.mutation(api.hostedLive.publish, {
				runId,
				claimId,
				attemptSeq: 1,
				streamId: 'stream-live',
				sequence: 2,
				text: 'Hello?',
				parts: [textPart('Hello?')],
				executionSecret
			})
		).rejects.toThrow(RUN_CANCELLED_BY_USER);

		await t.run(async (ctx) => {
			await ctx.db.patch('runs', runId, {
				status: 'cancelled',
				completedAt: Date.now()
			});
		});
		expect(await asUser.query(api.hostedLive.get, { threadId })).toBeNull();
	});

	it('hides a snapshot once the durable turn for that stream exists', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'user_live_final');
		const executionSecret = 'hosted-live-final';
		const runId = await startLiveRun(t, asUser, threadId, executionSecret);
		const parts = [textPart('Done', 'stream-final')];
		await asUser.mutation(api.hostedLive.publish, {
			runId,
			claimId,
			attemptSeq: 1,
			streamId: 'stream-final',
			sequence: 1,
			text: 'Done',
			parts,
			executionSecret
		});
		expect(await asUser.query(api.hostedLive.get, { threadId })).not.toBeNull();
		await asUser.mutation(api.agentRuntime.finalizeCompletionCall, {
			runId,
			claimId,
			attemptSeq: 1,
			streamId: 'stream-final',
			items: parts,
			executionSecret
		});
		expect(await asUser.query(api.hostedLive.get, { threadId })).toBeNull();
	});

	it('hides a snapshot after a newer completion attempt is registered', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'user_live_supersede');
		const executionSecret = 'hosted-live-supersede';
		const runId = await startLiveRun(t, asUser, threadId, executionSecret);
		await asUser.mutation(api.hostedLive.publish, {
			runId,
			claimId,
			attemptSeq: 1,
			streamId: 'stream-old',
			sequence: 1,
			text: 'Old',
			parts: [textPart('Old', 'stream-old')],
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.registerCompletionAttempt, {
			runId,
			claimId,
			attemptSeq: 2,
			executionSecret
		});
		expect(await asUser.query(api.hostedLive.get, { threadId })).toBeNull();
	});

	it('rejects an oversized snapshot', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'user_live_size');
		const executionSecret = 'hosted-live-size';
		const runId = await startLiveRun(t, asUser, threadId, executionSecret);
		const text = 'a'.repeat(MAX_LIVE_SNAPSHOT_BYTES);
		await expect(
			asUser.mutation(api.hostedLive.publish, {
				runId,
				claimId,
				attemptSeq: 1,
				streamId: 'stream-live',
				sequence: 1,
				text,
				parts: [textPart(text)],
				executionSecret
			})
		).rejects.toThrow('Live snapshot is too large.');
	});

	it('strips empty reasoning from the stored overlay', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'user_live_hidden');
		const executionSecret = 'hosted-live-hidden';
		const runId = await startLiveRun(t, asUser, threadId, executionSecret);
		await asUser.mutation(api.hostedLive.publish, {
			runId,
			claimId,
			attemptSeq: 1,
			streamId: 'stream-live',
			sequence: 1,
			text: 'Visible',
			parts: [
				{ type: 'reasoning', id: 'empty', text: ' \n', turnId: 'stream-live' },
				textPart('Visible')
			],
			executionSecret
		});
		expect(await asUser.query(api.hostedLive.get, { threadId })).toMatchObject({
			text: 'Visible',
			parts: [textPart('Visible')]
		});
	});

	it('accepts sequence 1 on a new claim after a high persisted sequence', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'user_live_resume');
		const executionSecret = 'hosted-live-resume';
		const runId = await startLiveRun(t, asUser, threadId, executionSecret);
		await asUser.mutation(api.hostedLive.publish, {
			runId,
			claimId,
			attemptSeq: 1,
			streamId: 'stream-old-claim',
			sequence: 1,
			text: 'Old claim',
			parts: [textPart('Old claim', 'stream-old-claim')],
			executionSecret
		});
		await t.run(async (ctx) => {
			const run = await ctx.db.get('runs', runId);
			if (!run?.completionStreamStateId) throw new Error('Expected stream state');
			await ctx.db.patch('completionStreamStates', run.completionStreamStateId, { sequence: 50 });
			await ctx.db.patch('runs', runId, { claimId: 'claim-resume' });
		});
		expect(await asUser.query(api.hostedLive.get, { threadId })).toBeNull();
		await asUser.mutation(api.hostedLive.publish, {
			runId,
			claimId: 'claim-resume',
			attemptSeq: 1,
			streamId: 'stream-resume',
			sequence: 1,
			text: 'Resumed',
			parts: [textPart('Resumed', 'stream-resume')],
			executionSecret
		});
		expect(await asUser.query(api.hostedLive.get, { threadId })).toMatchObject({
			streamId: 'stream-resume',
			text: 'Resumed'
		});
	});

	it('accepts sequence 1 on a new attempt epoch for the same claim', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'user_live_epoch');
		const executionSecret = 'hosted-live-epoch';
		const runId = await startLiveRun(t, asUser, threadId, executionSecret);
		await asUser.mutation(api.hostedLive.publish, {
			runId,
			claimId,
			attemptSeq: 1,
			streamId: 'stream-turn-1',
			sequence: 4,
			text: 'Turn one',
			parts: [textPart('Turn one', 'stream-turn-1')],
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.registerCompletionAttempt, {
			runId,
			claimId,
			attemptSeq: 2,
			executionSecret
		});
		expect(await asUser.query(api.hostedLive.get, { threadId })).toBeNull();
		await asUser.mutation(api.hostedLive.publish, {
			runId,
			claimId,
			attemptSeq: 2,
			streamId: 'stream-turn-2',
			sequence: 1,
			text: 'Turn two',
			parts: [textPart('Turn two', 'stream-turn-2')],
			executionSecret
		});
		expect(await asUser.query(api.hostedLive.get, { threadId })).toMatchObject({
			streamId: 'stream-turn-2',
			text: 'Turn two'
		});
	});

	it('rejects more live parts than the cap', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'user_live_parts');
		const executionSecret = 'hosted-live-parts';
		const runId = await startLiveRun(t, asUser, threadId, executionSecret);
		const parts = Array.from({ length: MAX_LIVE_PARTS + 1 }, (_, index) => ({
			type: 'text' as const,
			id: `t${index}`,
			text: 'x'
		}));
		await expect(
			asUser.mutation(api.hostedLive.publish, {
				runId,
				claimId,
				attemptSeq: 1,
				streamId: 'stream-live',
				sequence: 1,
				text: 'x',
				parts,
				executionSecret
			})
		).rejects.toThrow('Live snapshot has too many parts.');
	});
});
