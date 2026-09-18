import { describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';
import { sectionDisplayOrder } from './lib/transcriptSectionWrites';

describe('write-time transcript sections', () => {
	it('automatically migrates unindexed history across batches without creating sections', async () => {
		vi.useFakeTimers();
		try {
			const t = initConvexTest();
			const { threadId } = await seedOwnedThread(t);
			await t.run(async (ctx) => {
				const run = await ctx.db.query('runs').first();
				if (!run) throw new Error('Missing run.');
				for (let number = 0; number < 51; number++) {
					await ctx.db.insert('threadTranscriptParts', {
						threadId,
						userId: run.userId,
						runId: run._id,
						number,
						sourceKey: `old-${number}`,
						kind: 'completion',
						completion: {
							items: [
								{
									type: 'reasoning',
									id: 'reasoning',
									text: 'Thinking',
									turnId: 'turn',
									startedAt: null,
									completedAt: null
								}
							]
						}
					});
				}
			});
			await t.mutation(internal.migrations.runTranscriptWriteTimeSectionMigration, {});
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			await t.mutation(internal.migrations.runTranscriptWriteTimeSectionMigration, {});
			const result = await t.run(async (ctx) => ({
				parts: await ctx.db.query('threadTranscriptParts').collect(),
				sections: await ctx.db.query('threadTranscriptWorkSections').collect(),
				schedule: await ctx.db.query('migrationSchedules').unique()
			}));
			expect(result.parts).toHaveLength(51);
			expect(result.parts.every((part) => part.work?.ranges.length === 0)).toBe(true);
			expect(result.sections).toEqual([]);
			expect(result.schedule?.completedAt).toBeDefined();
		} finally {
			vi.useRealTimers();
		}
	});
	it('orders sections by run start before per-run ordinal', () => {
		const older = sectionDisplayOrder(100, 'run-a', 9);
		const newer = sectionDisplayOrder(101, 'run-b', 1);
		const sameTimeOtherRun = sectionDisplayOrder(100, 'run-b', 1);
		expect([newer, sameTimeOtherRun, older].sort()).toEqual([older, sameTimeOtherRun, newer]);
	});
	it('persists immutable assignments, reverse entries, summaries, and idempotent tool dispatch', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'write-time-sections-secret';
		const claimId = 'write-time-sections-claim';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'write-time-sections-submission',
			executionSecret
		);
		await asUser.mutation(api.agentRuntime.start, { runId, claimId, executionSecret });
		await asUser.mutation(api.agentRuntime.registerCompletionAttempt, {
			runId,
			claimId,
			attemptSeq: 1,
			executionSecret
		});
		const sectionKey = `agent:${runId}:${claimId}:1:section:1`;

		const toolArgs = {
			runId,
			claimId,
			kind: 'exec_command' as const,
			payload: { cmd: 'printf ok' },
			callId: 'call-1',
			toolInvocationId: 'invocation-1',
			sectionKey,
			sectionOrdinal: 1,
			attemptSeq: 1,
			streamId: 'stream-1',
			executionSecret
		};
		const firstJob = await asUser.mutation(api.agentRuntime.beginToolJob, toolArgs);
		const retriedJob = await asUser.mutation(api.agentRuntime.beginToolJob, toolArgs);
		expect(retriedJob).toEqual(firstJob);

		const items = [
			{
				type: 'reasoning' as const,
				id: 'reasoning-1',
				text: 'Inspecting',
				turnId: 'stream-1',
				startedAt: 1,
				completedAt: 2
			},
			{
				type: 'tool-call' as const,
				partId: 'tool-1',
				callId: 'call-1',
				name: 'exec_command',
				input: { cmd: 'printf ok' },
				turnId: 'stream-1',
				startedAt: 2,
				completedAt: 3
			}
		];
		const completionArgs = {
			runId,
			claimId,
			attemptSeq: 1,
			streamId: 'stream-1',
			items,
			work: { ranges: [{ start: 0, end: 2, sectionKey }] },
			toolInvocations: [{ callId: 'call-1', toolInvocationId: 'invocation-1', sectionKey }],
			sections: [{ sectionKey, sectionOrdinal: 1, closed: false }],
			executionSecret
		};
		const part = await asUser.mutation(api.agentRuntime.finalizeCompletionCall, completionArgs);
		const retry = await asUser.mutation(api.agentRuntime.finalizeCompletionCall, completionArgs);
		expect(retry?._id).toBe(part?._id);
		expect(part?.work).toEqual({
			...completionArgs.work,
			toolInvocations: [{ item: 1, toolInvocationId: 'invocation-1' }]
		});
		await expect(
			asUser.mutation(api.agentRuntime.finalizeCompletionCall, {
				...completionArgs,
				sections: [{ sectionKey, sectionOrdinal: 1, closed: true }]
			})
		).rejects.toThrow('Conflicting transcript section retry.');
		await expect(
			asUser.mutation(api.agentRuntime.beginToolJob, {
				...toolArgs,
				payload: { cmd: 'printf changed' }
			})
		).rejects.toThrow('Conflicting tool invocation retry.');

		const stored = await t.run(async (ctx) => ({
			entries: await ctx.db.query('threadTranscriptMemberships').collect(),
			sections: await ctx.db.query('threadTranscriptWorkSections').collect(),
			run: await ctx.db.get('runs', runId)
		}));
		expect(stored.entries).toHaveLength(2);
		expect(stored.sections).toHaveLength(1);
		expect(stored.sections[0]).toMatchObject({
			key: sectionKey,
			sectionOrdinal: 1,
			pendingTools: 1,
			itemCount: 2
		});
		expect(stored.sections[0].displayOrder).toBe(
			`${String(stored.run?.startedAt).padStart(16, '0')}:${runId}:000000000001`
		);
	}, 15_000);

	it('migrates fully, partially, and never indexed parts in bounded batches', async () => {
		const t = initConvexTest();
		const { threadId } = await seedOwnedThread(t);
		const runId = await t.run(async (ctx) => {
			const run = await ctx.db
				.query('runs')
				.withIndex('by_threadId_startedAt', (q) => q.eq('threadId', threadId))
				.unique();
			if (!run) throw new Error('Missing run.');
			const item = {
				type: 'reasoning' as const,
				id: 'reasoning',
				text: 'thinking',
				turnId: 'turn',
				startedAt: null,
				completedAt: null
			};
			await ctx.db.insert('threadTranscriptParts', {
				threadId,
				userId: run.userId,
				number: 1,
				sourceKey: 'full',
				kind: 'completion',
				runId: run._id,
				completion: { items: [item] },
				work: { processed: 1, ranges: [{ start: 0, end: 1, sectionKey: 'full' }] }
			});
			await ctx.db.insert('threadTranscriptParts', {
				threadId,
				userId: run.userId,
				number: 2,
				sourceKey: 'partial',
				kind: 'completion',
				runId: run._id,
				completion: { items: [item] }
			});
			await ctx.db.insert('threadTranscriptMemberships', {
				threadId,
				number: 2,
				work: { processed: 1, ranges: [{ start: 0, end: 1, sectionKey: 'partial' }] }
			});
			await ctx.db.insert('threadTranscriptParts', {
				threadId,
				userId: run.userId,
				number: 3,
				sourceKey: 'never',
				kind: 'completion',
				runId: run._id,
				completion: { items: [item] }
			});
			return run._id;
		});

		await t.mutation(internal.migrations.assignTranscriptSectionsAtWriteTime, {
			cursor: null,
			dryRun: false,
			oneBatchOnly: true
		});
		const migrated = await t.run(async (ctx) => ({
			parts: await ctx.db
				.query('threadTranscriptParts')
				.withIndex('by_threadId_and_runId_and_number', (q) =>
					q.eq('threadId', threadId).eq('runId', runId)
				)
				.collect(),
			entries: await ctx.db.query('threadTranscriptMemberships').collect()
		}));
		expect(migrated.parts.every((part) => part.work !== undefined)).toBe(true);
		expect(migrated.parts.flatMap((part) => part.work?.ranges ?? [])).toHaveLength(2);
		expect(migrated.parts.find((part) => part.sourceKey === 'never')?.work).toEqual({ ranges: [] });
		expect(migrated.entries.filter((entry) => entry.entryKey !== undefined)).toHaveLength(2);
	}, 15_000);
});
