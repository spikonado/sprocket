import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';

type FinalizeRunTestArgs = {
	runId: Id<'runs'>;
	text: string;
	status: 'completed' | 'failed' | 'cancelled';
	lastError?: string;
};

async function completeRun(
	t: ReturnType<typeof initConvexTest>,
	asUser: ReturnType<ReturnType<typeof initConvexTest>['withIdentity']>,
	args: {
		runId: Id<'runs'>;
		executionSecret: string;
		status: 'completed' | 'failed' | 'cancelled';
		responseText?: string;
		startedAt?: number;
	}
) {
	await asUser.mutation(api.agentRuntime.start, {
		claimId: `claim-${args.runId}`,
		runId: args.runId,
		executionSecret: args.executionSecret
	});
	await asUser.mutation(api.agentRuntime.beginAssistantMessage, {
		runId: args.runId,
		executionSecret: args.executionSecret
	});
	const finalizeArgs: FinalizeRunTestArgs = {
		runId: args.runId,
		text: args.responseText ?? `Response for ${args.runId}`,
		status: args.status
	};
	if (args.status === 'failed') finalizeArgs.lastError = 'failed';
	await asUser.mutation(api.agentRuntime.finalizeRun, finalizeArgs);
	if (args.startedAt !== undefined) {
		await t.run(async (ctx) => {
			await ctx.db.patch(args.runId, { startedAt: args.startedAt });
		});
	}
}

describe('messages transcript queries', () => {
	it('keeps active runs in live and excludes them from history', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const active = await createQueuedRun(
			asUser,
			threadId,
			'sub-active',
			'messages-live-secret',
			'Live prompt'
		);

		const history = await asUser.query(api.messages.listHistoryForThread, { threadId });
		const live = await asUser.query(api.messages.listLiveForThread, { threadId });

		expect(history.messages).toEqual([]);
		expect(live.messages).toHaveLength(1);
		expect(live.messages[0]).toMatchObject({
			_id: active.promptMessageId,
			type: 'prompt',
			text: 'Live prompt',
			runStatus: 'queued'
		});
	});

	it('streams live responses then moves terminal runs into history', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'messages-stream-secret';
		const { runId } = await createQueuedRun(
			asUser,
			threadId,
			'sub-stream',
			executionSecret,
			'Stream me'
		);

		await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-stream',
			runId,
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.beginAssistantMessage, { runId, executionSecret });

		const responseMessageId = await t.run(async (ctx) => {
			const run = await ctx.db.get(runId);
			if (!run?.responseMessageId) {
				throw new Error('Expected response message');
			}
			await ctx.db.patch(run.responseMessageId, {
				text: 'partial answer',
				parts: [{ type: 'text', id: 't1', text: 'partial answer', turnId: 'turn-1' }]
			});
			return run.responseMessageId;
		});

		const streaming = await asUser.query(api.messages.listLiveForThread, { threadId });
		expect(streaming.messages.map((message) => message.type)).toEqual(['prompt', 'response']);
		expect(streaming.messages[1]).toMatchObject({
			_id: responseMessageId,
			text: 'partial answer',
			runStatus: 'running'
		});
		expect((await asUser.query(api.messages.listHistoryForThread, { threadId })).messages).toEqual(
			[]
		);

		await asUser.mutation(api.agentRuntime.finalizeRun, {
			runId,
			text: 'final answer',
			status: 'completed'
		});

		expect((await asUser.query(api.messages.listLiveForThread, { threadId })).messages).toEqual([]);
		const historyAfter = await asUser.query(api.messages.listHistoryForThread, { threadId });
		expect(
			historyAfter.messages.map((message) => [message.type, message.text, message.runStatus])
		).toEqual([
			['prompt', 'Stream me', 'completed'],
			['response', 'partial answer', 'completed']
		]);
	});

	it('orders history chronologically across terminal statuses and bounds to newest 20 runs', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const statuses = ['completed', 'failed', 'cancelled'] as const;

		for (let index = 0; index < 25; index += 1) {
			const executionSecret = `messages-bound-secret-${index}`;
			const created = await createQueuedRun(
				asUser,
				threadId,
				`sub-bound-${index}`,
				executionSecret,
				`P${index}`
			);
			await completeRun(t, asUser, {
				runId: created.runId,
				executionSecret,
				status: statuses[index % statuses.length]!,
				responseText: `R${index}`,
				startedAt: 1_000 + index
			});
		}

		const history = await asUser.query(api.messages.listHistoryForThread, { threadId });
		const promptTexts = history.messages
			.filter((message) => message.type === 'prompt')
			.map((message) => message.text);
		expect(promptTexts).toEqual(Array.from({ length: 20 }, (_, index) => `P${index + 5}`));
		expect(history.messages).toHaveLength(40);
		expect(history.messages.map((message) => message.text)).toEqual(
			promptTexts.flatMap((prompt, index) => [prompt, `R${index + 5}`])
		);
	});
});
