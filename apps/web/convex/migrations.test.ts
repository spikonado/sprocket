import { expect, test, vi } from 'vitest';
import { internal } from '@convex/_generated/api';
import { initConvexTest, seedOwnedThread } from '@convex/test.setup';

test('run backfills tool invocation IDs from source keys', async () => {
	vi.useFakeTimers();
	const t = initConvexTest();
	const { threadId } = await seedOwnedThread(t);
	const migratedSourceKey = 'migrated-tool:message-1:web_search_3';

	const toolPart = {
		threadId,
		kind: 'tool' as const,
		tool: { callId: 'web_search_3', name: 'web_search', status: 'completed' as const },
		work: { ranges: [] }
	};

	const [migratedId, currentId] = await t.run(async (ctx) => {
		const run = await ctx.db
			.query('runs')
			.withIndex('by_threadId', (q) => q.eq('threadId', threadId))
			.unique();

		if (!run) throw new Error('Missing fixture run.');

		return Promise.all([
			ctx.db.insert('threadTranscriptParts', {
				...toolPart,
				runId: run._id,
				number: 0,
				sourceKey: migratedSourceKey
			}),
			ctx.db.insert('threadTranscriptParts', {
				...toolPart,
				runId: run._id,
				number: 1,
				sourceKey: 'tool:invocation-1:finished',
				tool: { ...toolPart.tool, toolInvocationId: 'invocation-1' }
			})
		]);
	});

	await t.mutation(internal.migrations.run, {});
	await t.finishAllScheduledFunctions(vi.runAllTimers);

	const [migrated, current] = await t.run((ctx) =>
		Promise.all([
			ctx.db.get('threadTranscriptParts', migratedId),
			ctx.db.get('threadTranscriptParts', currentId)
		])
	);

	expect(migrated?.tool?.toolInvocationId).toBe(migratedSourceKey);
	expect(current?.tool?.toolInvocationId).toBe('invocation-1');
	vi.useRealTimers();
});
