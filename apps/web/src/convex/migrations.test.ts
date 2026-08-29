import { describe, expect, it } from 'vitest';
import { internal } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import {
	TRANSCRIPT_NUMBERING_VERIFY_BATCH,
	verifyThreadTranscriptNumbering
} from '@convex/lib/transcriptMigrate';
import { getTranscriptState } from '@convex/lib/transcriptParts';
import { initConvexTest, seedOwnedThread, type ConvexTestInstance } from './test.setup';

async function seedUnmigratedTranscript(
	t: ConvexTestInstance,
	args: {
		threadId: Id<'threadRecords'>;
		userId: string;
		totalParts: number;
		submissionId: string;
		numbers?: number[];
	}
) {
	const numbers = args.numbers ?? Array.from({ length: args.totalParts }, (_, number) => number);
	await t.run(async (ctx) => {
		const runId = await ctx.db.insert('runs', {
			threadId: args.threadId,
			userId: args.userId,
			submissionId: args.submissionId,
			status: 'completed',
			executionSecretHash: 'hash',
			completionAttemptSeq: 0,
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			serviceTier: 'standard',
			startedAt: 1,
			completedAt: 2
		});
		await ctx.db.insert('threadTranscriptStates', {
			threadId: args.threadId,
			userId: args.userId,
			totalParts: args.totalParts
		});
		for (const number of numbers) {
			await ctx.db.insert('threadTranscriptParts', {
				threadId: args.threadId,
				userId: args.userId,
				number,
				sourceKey: `part:${number}`,
				kind: 'prompt',
				runId,
				prompt: { text: `p${number}`, imageUploads: [] }
			});
		}
	});
}

describe('retired model migrations', () => {
	it('rewrites retired thread and run model ids', async () => {
		const t = initConvexTest();
		const { threadId } = await seedOwnedThread(t);
		const { runId, unknownThreadId } = await t.run(async (ctx) => {
			await ctx.db.patch('threadRecords', threadId, {
				selectedModel: 'gpt-5.6-terra',
				serviceTier: 'fast'
			});
			const thread = await ctx.db.get('threadRecords', threadId);
			if (!thread) throw new Error('thread missing');
			const unknownThreadId = await ctx.db.insert('threadRecords', {
				userId: thread.userId,
				submissionId: 'unknown-gateway-model',
				repositoryKey: thread.repositoryKey,
				selectedModel: 'gateway-only-model',
				reasoningEffort: 'medium',
				serviceTier: 'fast',
				lastMessageAt: Date.now()
			});
			const runId = await ctx.db.insert('runs', {
				threadId,
				userId: thread.userId,
				submissionId: 'retired-run',
				status: 'completed',
				executionSecretHash: 'hash',
				completionAttemptSeq: 0,
				selectedModel: 'gpt-5.6-terra',
				reasoningEffort: 'medium',
				serviceTier: 'fast',
				startedAt: Date.now(),
				completedAt: Date.now()
			});
			return { runId, unknownThreadId };
		});

		await t.mutation(internal.migrations.rewriteRetiredThreadModels, {});
		await t.mutation(internal.migrations.rewriteRetiredRunModels, {});

		const rewritten = await t.run(async (ctx) => ({
			thread: await ctx.db.get('threadRecords', threadId),
			unknown: await ctx.db.get('threadRecords', unknownThreadId),
			run: await ctx.db.get('runs', runId)
		}));
		expect(rewritten.thread?.selectedModel).toBe('gpt-5.6-sol');
		expect(rewritten.thread?.serviceTier).toBe('fast');
		expect(rewritten.unknown?.selectedModel).toBe('gateway-only-model');
		expect(rewritten.unknown?.serviceTier).toBe('fast');
		expect(rewritten.run?.selectedModel).toBe('gpt-5.6-sol');
		expect(rewritten.run?.serviceTier).toBe('fast');
	});
});

describe('projectId rewrite', () => {
	it('copies projects.repositoryKey onto threads and unsets leftover projectId', async () => {
		const t = initConvexTest();
		const { asUser, subject, threadId } = await seedOwnedThread(t);
		const ids = await t.run(async (ctx) => {
			const projectId = await ctx.db.insert('projects', {
				userId: subject,
				repositoryKey: 'github.com/spikonado/sprocket',
				displayName: 'sprocket',
				nextExecutorSequence: 0,
				lastSeenAt: Date.now()
			});
			await ctx.db.patch('threadRecords', threadId, {
				repositoryKey: undefined,
				projectId
			});
			const runId = await ctx.db.insert('runs', {
				threadId,
				userId: subject,
				submissionId: 'legacy-project-run',
				projectId,
				status: 'completed',
				executionSecretHash: 'hash',
				completionAttemptSeq: 0,
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				serviceTier: 'standard',
				startedAt: Date.now(),
				completedAt: Date.now()
			});
			const jobId = await ctx.db.insert('executorJobs', {
				threadId,
				runId,
				projectId,
				kind: 'exec_command',
				payload: { cmd: 'echo hi' },
				hidden: false,
				status: 'completed',
				enqueuedAt: Date.now(),
				sequence: 0
			});
			return { projectId, runId, jobId };
		});

		await asUser.mutation(internal.migrations.backfillThreadRepositoryKeys, {});
		await asUser.mutation(internal.migrations.unsetRunProjectIds, {});
		await asUser.mutation(internal.migrations.unsetExecutorJobProjectIds, {});

		const rewritten = await t.run(async (ctx) => ({
			thread: await ctx.db.get('threadRecords', threadId),
			run: await ctx.db.get('runs', ids.runId),
			job: await ctx.db.get('executorJobs', ids.jobId)
		}));
		expect(rewritten.thread?.repositoryKey).toBe('github.com/spikonado/sprocket');
		expect(rewritten.thread?.projectId).toBeUndefined();
		expect(rewritten.run?.projectId).toBeUndefined();
		expect(rewritten.job?.projectId).toBeUndefined();
	});

	it('keeps projectId when the referenced project row is gone', async () => {
		const t = initConvexTest();
		const { subject, threadId } = await seedOwnedThread(t);
		const projectId = await t.run(async (ctx) => {
			const projectId = await ctx.db.insert('projects', {
				userId: subject,
				repositoryKey: 'github.com/spikonado/missing',
				displayName: 'missing',
				nextExecutorSequence: 0,
				lastSeenAt: Date.now()
			});
			await ctx.db.patch('threadRecords', threadId, {
				repositoryKey: undefined,
				projectId
			});
			await ctx.db.delete('projects', projectId);
			return projectId;
		});

		await t.mutation(internal.migrations.backfillThreadRepositoryKeys, {});

		const thread = await t.run(async (ctx) => ctx.db.get('threadRecords', threadId));
		expect(thread?.repositoryKey).toBeUndefined();
		expect(thread?.projectId).toBe(projectId);
	});
});

describe('transcript numbering verification', () => {
	it('pages past the per-transaction part cap and still sets migratedAt', async () => {
		const t = initConvexTest();
		const { subject, threadId } = await seedOwnedThread(t);
		const totalParts = TRANSCRIPT_NUMBERING_VERIFY_BATCH + 8;
		await seedUnmigratedTranscript(t, {
			threadId,
			userId: subject,
			totalParts,
			submissionId: 'verify-many-parts'
		});

		await t.mutation(internal.migrations.verifyThreadTranscriptReplicas, {});
		await t.finishAllScheduledFunctions(() => {});

		const state = await t.run(async (ctx) => getTranscriptState(ctx, threadId));
		expect(state?.migratedAt).toEqual(expect.any(Number));
		expect(state?.totalParts).toBe(totalParts);
	});

	it('does not mark a gapped transcript as migrated', async () => {
		const t = initConvexTest();
		const { subject, threadId } = await seedOwnedThread(t);
		await seedUnmigratedTranscript(t, {
			threadId,
			userId: subject,
			totalParts: 3,
			numbers: [0, 2],
			submissionId: 'verify-gap'
		});

		await expect(
			t.run(async (ctx) => verifyThreadTranscriptNumbering(ctx, threadId, subject))
		).resolves.toEqual({ status: 'incomplete' });

		const state = await t.run(async (ctx) => getTranscriptState(ctx, threadId));
		expect(state?.migratedAt).toBeUndefined();
	});
});
