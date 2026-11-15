import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { initConvexTest, seedOwnedThread } from '../test.setup';
import { getOrCreateTranscriptState } from './transcriptParts';

describe('context handoff part-number cutoff', () => {
	it('loads the full transcript for an unsummarized thread', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);

		expect(await asUser.query(api.transcript.getState, { threadId })).toMatchObject({
			historyFromNumber: 0
		});
	});

	it('loads the full transcript after a handoff covering an empty prefix', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		await t.run((ctx) =>
			ctx.db.patch('threadRecords', threadId, {
				contextSummary: 'No prior work',
				contextSummaryPartCount: 0
			})
		);

		expect(await asUser.query(api.transcript.getState, { threadId })).toMatchObject({
			historyFromNumber: 0,
			contextSummary: 'No prior work'
		});
	});

	it.each([
		['threadRecords', 0],
		['threadTranscriptStates', 3]
	] as const)('loads context from %s during migration', async (table, historyFromNumber) => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		await t.run(async (ctx) => {
			const state = await getOrCreateTranscriptState(ctx, threadId);
			await ctx.db.patch(table, table === 'threadRecords' ? threadId : state._id, {
				contextSummary: 'Covered prior work',
				contextSummaryPartCount: historyFromNumber,
				reasoningStrippedThroughPartNumber: 2
			});
		});

		expect(await asUser.query(api.transcript.getState, { threadId })).toMatchObject({
			historyFromNumber,
			contextSummary: 'Covered prior work',
			reasoningStrippedThroughPartNumber: 2
		});
	});

	it('rejects a summary missing its cutoff instead of replaying covered reasoning', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		await t.run((ctx) =>
			ctx.db.patch('threadRecords', threadId, {
				contextSummary: 'Covered prior work'
			})
		);

		await expect(asUser.query(api.transcript.getState, { threadId })).rejects.toThrow(
			'Conversation context is missing its history cutoff.'
		);
	});
});
