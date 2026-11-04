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

test('run removes stored artifact types', async () => {
	vi.useFakeTimers();
	const t = initConvexTest();

	const artifactId = await t.run((ctx) =>
		ctx.db.insert('artifacts', {
			userId: 'user_alice',
			scope: 'project',
			repositoryKey: 'alpha',
			registrationId: 'registration',
			content: '<p>hi</p>',
			type: 'html',
			title: 'page.html',
			revision: 1,
			updatedAt: 1
		})
	);

	await t.mutation(internal.migrations.run, {});
	await t.finishAllScheduledFunctions(vi.runAllTimers);

	const artifact = await t.run((ctx) => ctx.db.get('artifacts', artifactId));
	expect(artifact).not.toHaveProperty('type');
	expect(artifact?.title).toBe('page.html');
	vi.useRealTimers();
});

test('run converts context summary cutoffs to part counts and drops pricing cache keys', async () => {
	vi.useFakeTimers();
	const t = initConvexTest();
	const { threadId: emptyPrefixThreadId } = await seedOwnedThread(t);
	const { threadId: summarizedThreadId } = await seedOwnedThread(t);

	const pricingRowId = await t.run(async (ctx) => {
		await ctx.db.patch('threadRecords', emptyPrefixThreadId, {
			contextSummary: 'Nothing yet',
			contextSummaryThroughPartNumber: -1
		});
		await ctx.db.patch('threadRecords', summarizedThreadId, {
			contextSummary: 'Covered work',
			contextSummaryThroughPartNumber: 4
		});

		return ctx.db.insert('dodoPricingCache', {
			cacheKey: 'live_mode:prod_1',
			environment: 'live_mode',
			productId: 'prod_1',
			expiresAt: 0
		});
	});

	await t.mutation(internal.migrations.run, {});
	await t.finishAllScheduledFunctions(vi.runAllTimers);

	const [emptyPrefix, summarized, pricingRow] = await t.run((ctx) =>
		Promise.all([
			ctx.db.get('threadRecords', emptyPrefixThreadId),
			ctx.db.get('threadRecords', summarizedThreadId),
			ctx.db.get('dodoPricingCache', pricingRowId)
		])
	);

	expect(emptyPrefix).toMatchObject({ contextSummaryPartCount: 0 });
	expect(emptyPrefix).not.toHaveProperty('contextSummaryThroughPartNumber');
	expect(summarized).toMatchObject({ contextSummaryPartCount: 5 });
	expect(pricingRow).not.toHaveProperty('cacheKey');
	vi.useRealTimers();
});
