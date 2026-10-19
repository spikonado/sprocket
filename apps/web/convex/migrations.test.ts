import { describe, expect, it } from 'vitest';
import { internal } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { sectionDisplayOrder } from '@convex/lib/transcriptSectionWrites';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';

describe('unsetRetiredRunFields', () => {
	it('moves legacy run starts and their section orders onto the creation time', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const { runId } = await createQueuedRun(t, asUser, threadId, 'legacy-run', 'legacy-secret');
		const legacyStartedAt = 1_700_000_000_000;

		const section = (key: string, sectionRunId: Id<'runs'>, displayOrder: string) => ({
			threadId,
			key,
			runId: sectionRunId,
			sectionOrdinal: 3,
			displayOrder,
			first: { part: 1, item: 0 },
			end: { part: 1, item: 0 },
			closed: true,
			provisional: false,
			itemCount: 1,
			pendingTools: 0
		});

		const [legacySectionId, otherSectionId, otherOrder] = await t.run(async (ctx) => {
			await ctx.db.patch('runs', runId, {
				startedAt: legacyStartedAt,
				gatewayProtocolVersion: 1,
				cancellationDeadlineAt: 1
			});

			const otherRunId = await ctx.db.insert('runs', {
				threadId,
				userId: 'user_alice',
				submissionId: 'other-run',
				status: 'completed',
				executionSecretHash: 'other',
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				fastMode: false
			});

			const order = sectionDisplayOrder(legacyStartedAt, otherRunId, 3);

			return [
				await ctx.db.insert(
					'threadTranscriptWorkSections',
					section('legacy', runId, sectionDisplayOrder(legacyStartedAt, runId, 3))
				),
				await ctx.db.insert('threadTranscriptWorkSections', section('other', otherRunId, order)),
				order
			] as const;
		});

		await t.mutation(internal.migrations.unsetRetiredRunFields, { cursor: null, dryRun: false });

		await t.run(async (ctx) => {
			const run = (await ctx.db.get('runs', runId))!;
			expect(run.startedAt).toBeUndefined();
			expect(run.gatewayProtocolVersion).toBeUndefined();
			expect(run.cancellationDeadlineAt).toBeUndefined();
			expect(
				(await ctx.db.get('threadTranscriptWorkSections', legacySectionId))?.displayOrder
			).toBe(sectionDisplayOrder(Math.floor(run._creationTime), runId, 3));
			expect((await ctx.db.get('threadTranscriptWorkSections', otherSectionId))?.displayOrder).toBe(
				otherOrder
			);
		});
	});
});
