import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { initConvexTest, seedOwnedThread } from '../test.setup';

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
				contextSummaryThroughPartNumber: -1
			})
		);

		expect(await asUser.query(api.transcript.getState, { threadId })).toMatchObject({
			historyFromNumber: 0,
			contextSummary: 'No prior work'
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
