import { expect, test, vi } from 'vitest';
import { internal } from '@convex/_generated/api';
import { initConvexTest, insertUser, seedOwnedThread } from '@convex/test.setup';

const DAY = 86_400_000;

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

test('run moves tier grants to users and strips projection fields from Dodo rows', async () => {
	vi.useFakeTimers();
	const t = initConvexTest();

	const { grantUserId, paidId, checkId } = await t.run(async (ctx) => {
		const checkId = await ctx.scheduler.runAfter(
			DAY,
			internal.billingAudit.deleteWebhookEvents,
			{}
		);

		const grantUserId = await insertUser(ctx, 'grant');
		await ctx.db.insert('subscriptions', { userId: 'grant', tier: 'pro', status: 'active' });
		await ctx.db.insert('subscriptions', { userId: 'bootstrap', tier: 'free', status: 'active' });
		await ctx.db.insert('subscriptionReconciliations', { subscriptionId: 'retired' });
		await ctx.db.insert('supersededSubscriptions', { dodoSubscriptionId: 'sub_retired' });

		const paidId = await ctx.db.insert('subscriptions', {
			userId: 'paid',
			tier: 'pro',
			status: 'active',
			eventAt: 1,
			dodoSubscriptionId: 'sub_paid',
			dodoProductId: 'prod_pro',
			billingPeriodStart: 1,
			billingPeriodEnd: 2,
			cancelAtNextBillingDate: false,
			accessPhase: 'paid',
			billingPeriodCheckId: checkId,
			quotaResetAt: 5,
			quotaGeneration: 2
		});

		return { grantUserId, paidId, checkId };
	});

	await t.mutation(internal.migrations.run, {});

	for (let step = 0; step < 30; step += 1) {
		vi.advanceTimersByTime(1);
		await t.finishInProgressScheduledFunctions();
	}

	const state = await t.run(async (ctx) => ({
		grantUser: await ctx.db.get('users', grantUserId),
		subscriptions: await ctx.db.query('subscriptions').collect(),
		paid: await ctx.db.get('subscriptions', paidId),
		check: await ctx.db.system.get('_scheduled_functions', checkId),
		retired: [
			...(await ctx.db.query('subscriptionReconciliations').collect()),
			...(await ctx.db.query('supersededSubscriptions').collect())
		]
	}));

	expect(state.grantUser?.grantedTier).toBe('pro');
	expect(state.subscriptions).toHaveLength(1);
	expect(state.paid).toEqual({
		_id: paidId,
		_creationTime: expect.any(Number),
		userId: 'paid',
		status: 'active',
		dodoSubscriptionId: 'sub_paid',
		dodoProductId: 'prod_pro',
		billingPeriodStart: 1,
		billingPeriodEnd: 2,
		cancelAtNextBillingDate: false,
		quotaResetAt: 5,
		syncedAt: 0
	});
	expect(state.check?.state.kind).toBe('canceled');
	expect(state.retired).toEqual([]);
	vi.useRealTimers();
});

test('run removes stored question settle timestamps', async () => {
	vi.useFakeTimers();
	const t = initConvexTest();
	const { threadId } = await seedOwnedThread(t);

	const questionId = await t.run(async (ctx) => {
		const run = await ctx.db
			.query('runs')
			.withIndex('by_threadId', (q) => q.eq('threadId', threadId))
			.unique();

		if (!run) throw new Error('Missing fixture run.');

		const jobId = await ctx.db.insert('executorJobs', {
			threadId,
			runId: run._id,
			kind: 'ask_question',
			toolInvocationId: 'invocation-question',
			payload: { question: 'Which?', options: [{ id: 'a', label: 'A' }] },
			status: 'completed',
			enqueuedAt: 1,
			claimedAt: 1,
			sequence: 0
		});

		return ctx.db.insert('agentQuestions', {
			threadId,
			runId: run._id,
			jobId,
			question: 'Which?',
			options: [{ id: 'a', label: 'A' }],
			status: 'skipped',
			answeredAt: 1,
			sequence: 1
		});
	});

	await t.mutation(internal.migrations.run, {});
	await t.finishAllScheduledFunctions(vi.runAllTimers);

	const question = await t.run((ctx) => ctx.db.get('agentQuestions', questionId));
	expect(question).not.toHaveProperty('answeredAt');
	expect(question?.status).toBe('skipped');
	vi.useRealTimers();
});
