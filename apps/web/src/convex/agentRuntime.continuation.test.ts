import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { RUN_ABANDONED_BY_AGENT } from '@convex/lib/agentErrors';
import { ONLY_LATEST_RUN_CAN_CONTINUE, RUN_CANNOT_CONTINUE } from '@convex/lib/runResume';
import { createQueuedRun, initConvexTest, insertQueuedRun, seedOwnedThread } from './test.setup';

describe('new-run continuation', { timeout: 30_000 }, () => {
	it('creates a linked run without a visible prompt and is idempotent', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const parent = await createQueuedRun(t, asUser, threadId, 'sub-parent', 'parent-secret');
		await asUser.mutation(api.agentRuntime.finalizeRun, {
			runId: parent.runId,
			text: '',
			status: 'failed',
			lastError: 'boom'
		});

		const args = {
			threadId,
			submissionId: 'sub-continue',
			executionSecret: 'continue-secret',
			prompt: '',
			continuationOfRunId: parent.runId,
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'high' as const,
			serviceTier: 'fast' as const
		};
		const created = await insertQueuedRun(t, asUser, args);
		expect(created).toMatchObject({ created: true, runId: expect.any(String) });
		expect(created.promptMessageId).toBeUndefined();
		expect(created.promptPart).toBeUndefined();
		expect(created.runId).not.toBe(parent.runId);

		const again = await insertQueuedRun(t, asUser, args);
		expect(again).toMatchObject({ created: false, runId: created.runId });

		const continuation = await t.run(async (ctx) => ctx.db.get('runs', created.runId));
		expect(continuation).toMatchObject({
			status: 'queued',
			continuationOfRunId: parent.runId,
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'high',
			serviceTier: 'fast',
			submissionId: 'sub-continue'
		});
		expect(continuation?.promptMessageId).toBeUndefined();

		const parts = await asUser.query(api.transcript.getParts, { threadId, numbers: [0, 1] });
		expect(parts.parts.map((part) => [part.number, part.kind, part.runId])).toEqual([
			[0, 'prompt', parent.runId]
		]);

		const context = await asUser.query(api.agentRuntime.getContext, {
			runId: created.runId,
			executionSecret: 'continue-secret'
		});
		expect(context.prompt).toBe('');
		expect(context.promptAttachments).toEqual([]);
		expect(context.run.continuationOfRunId).toBe(parent.runId);
	});

	it('rejects active, completed, and non-latest parents', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const active = await createQueuedRun(t, asUser, threadId, 'sub-active', 'active-secret');
		await expect(
			insertQueuedRun(t, asUser, {
				threadId,
				submissionId: 'sub-continue-active',
				executionSecret: 'continue-active-secret',
				prompt: '',
				continuationOfRunId: active.runId
			})
		).rejects.toThrow('Finish or cancel the active run before sending another message.');

		await asUser.mutation(api.agentRuntime.finalizeRun, {
			runId: active.runId,
			text: '',
			status: 'completed'
		});
		await expect(
			insertQueuedRun(t, asUser, {
				threadId,
				submissionId: 'sub-continue-completed',
				executionSecret: 'continue-completed-secret',
				prompt: '',
				continuationOfRunId: active.runId
			})
		).rejects.toThrow(RUN_CANNOT_CONTINUE);

		const failed = await createQueuedRun(t, asUser, threadId, 'sub-failed', 'failed-secret');
		await asUser.mutation(api.agentRuntime.finalizeRun, {
			runId: failed.runId,
			text: '',
			status: 'failed',
			lastError: 'boom'
		});
		const first = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'sub-continue-first',
			executionSecret: 'continue-first-secret',
			prompt: '',
			continuationOfRunId: failed.runId
		});
		await asUser.mutation(api.agentRuntime.finalizeRun, {
			runId: first.runId,
			text: '',
			status: 'cancelled'
		});
		await expect(
			insertQueuedRun(t, asUser, {
				threadId,
				submissionId: 'sub-continue-stale',
				executionSecret: 'continue-stale-secret',
				prompt: '',
				continuationOfRunId: failed.runId
			})
		).rejects.toThrow(ONLY_LATEST_RUN_CAN_CONTINUE);
	});

	it('rejects a second continuation while the first is still the latest run', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const parent = await createQueuedRun(t, asUser, threadId, 'sub-race-parent', 'race-parent');
		await asUser.mutation(api.agentRuntime.finalizeRun, {
			runId: parent.runId,
			text: '',
			status: 'cancelled'
		});
		await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'sub-race-one',
			executionSecret: 'race-one',
			prompt: '',
			continuationOfRunId: parent.runId
		});
		await expect(
			insertQueuedRun(t, asUser, {
				threadId,
				submissionId: 'sub-race-two',
				executionSecret: 'race-two',
				prompt: '',
				continuationOfRunId: parent.runId
			})
		).rejects.toThrow('Finish or cancel the active run before sending another message.');
	});

	it('fails an abandoned claimed parent, then continues from it', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const abandoned = await createQueuedRun(
			t,
			asUser,
			threadId,
			'sub-abandoned-continue',
			'abandoned-continue'
		);
		await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-abandoned-continue',
			runId: abandoned.runId,
			executionSecret: 'abandoned-continue'
		});
		await t.run(async (ctx) => {
			await ctx.db.patch('runs', abandoned.runId, { claimExpiresAt: Date.now() - 1 });
		});

		const continuation = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'sub-after-abandoned-continue',
			executionSecret: 'after-abandoned-continue',
			prompt: '',
			continuationOfRunId: abandoned.runId
		});
		expect(continuation.created).toBe(true);
		expect(continuation.runId).not.toBe(abandoned.runId);
		expect(await t.run(async (ctx) => ctx.db.get('runs', abandoned.runId))).toMatchObject({
			status: 'failed',
			lastError: RUN_ABANDONED_BY_AGENT
		});
		expect(await t.run(async (ctx) => ctx.db.get('runs', continuation.runId))).toMatchObject({
			continuationOfRunId: abandoned.runId,
			status: 'queued'
		});
	});

	it('reconciles a queued continuation after a failed start', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const parent = await createQueuedRun(t, asUser, threadId, 'sub-cleanup-parent', 'cleanup-parent');
		await asUser.mutation(api.agentRuntime.finalizeRun, {
			runId: parent.runId,
			text: '',
			status: 'failed',
			lastError: 'boom'
		});
		const args = {
			submissionId: 'sub-cleanup-continue',
			threadId,
			prompt: '',
			imageUploadIds: [],
			selectedModel: 'gpt-5.6-sol' as const,
			reasoningEffort: 'medium' as const,
			serviceTier: 'standard' as const
		};
		const created = await insertQueuedRun(t, asUser, {
			...args,
			executionSecret: 'cleanup-continue',
			continuationOfRunId: parent.runId
		});
		await expect(
			t.mutation(api.agentRuntime.finalizeFailedStart, {
				...args,
				executionSecret: 'cleanup-continue',
				text: 'Run failed before the model started.',
				lastError: 'startup timed out'
			})
		).resolves.toBe('finalized');
		expect(await t.run(async (ctx) => (await ctx.db.get('runs', created.runId))?.status)).toBe(
			'failed'
		);
	});
});
