import { expect, test, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import type { TranscriptCompletionItem } from '@convex/lib/validators';
import { initConvexTest, insertUser, seedOwnedThread } from '@convex/test.setup';
import { getOrCreateTranscriptState, getTranscriptState } from '@convex/lib/transcriptParts';

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

test('run backfills completion tool invocation IDs by item index and preserves legacy history', async () => {
	vi.useFakeTimers();
	const t = initConvexTest();
	const { threadId } = await seedOwnedThread(t);

	const toolCall = {
		type: 'tool-call' as const,
		callId: 'reused-call',
		name: 'web_search',
		input: { query: 'transcripts' },
		providerMetadata: { provider: 'preserved' }
	};

	const completion = {
		streamId: 'legacy-stream',
		items: [
			{ type: 'text' as const, id: 'text-1', text: 'Searching.' },
			toolCall,
			{ type: 'reasoning' as const, id: 'reasoning-1', text: 'Compare results.' },
			{ ...toolCall, input: { query: 'tool calls' } },
			{ ...toolCall, toolInvocationId: 'already-present' },
			{ ...toolCall, callId: 'unassigned-call' }
		]
	};

	const work = {
		ranges: [{ start: 1, end: 6, sectionKey: 'legacy-section' }],
		toolInvocations: [
			{ item: 3, toolInvocationId: 'second-invocation' },
			{ item: 1, toolInvocationId: 'first-invocation' },
			{ item: 4, toolInvocationId: 'stale-assignment' }
		]
	};

	const parts = await t.run(async (ctx) => {
		const run = await ctx.db
			.query('runs')
			.withIndex('by_threadId', (q) => q.eq('threadId', threadId))
			.unique();

		if (!run) throw new Error('Missing fixture run.');

		const bodies = [
			{ completion, work },
			{ completion: { items: [toolCall] }, work: { ranges: [] } }
		];

		return Promise.all(
			bodies.map(async (body, number) => {
				const id = await ctx.db.insert('threadTranscriptParts', {
					threadId,
					runId: run._id,
					kind: 'completion',
					number,
					sourceKey: `completion:legacy:${number}`,
					...body
				});

				return ctx.db.get('threadTranscriptParts', id);
			})
		);
	});

	await t.mutation(internal.migrations.run, {});
	await t.finishAllScheduledFunctions(vi.runAllTimers);

	const migrated = await t.run((ctx) =>
		ctx.db
			.query('threadTranscriptParts')
			.withIndex('by_threadId_and_number', (q) => q.eq('threadId', threadId))
			.collect()
	);

	const items: TranscriptCompletionItem[] = [...completion.items];
	items[1] = { ...toolCall, toolInvocationId: 'first-invocation' };
	items[3] = { ...toolCall, input: { query: 'tool calls' }, toolInvocationId: 'second-invocation' };
	expect(migrated).toEqual([{ ...parts[0], completion: { ...completion, items } }, parts[1]]);

	await t.mutation(internal.migrations.backfillCompletionToolInvocationIds, {
		cursor: null,
		oneBatchOnly: true,
		dryRun: false
	});
	expect(await t.run((ctx) => ctx.db.query('threadTranscriptParts').collect())).toEqual(migrated);
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

test.each([
	{ legacyStripped: 2, currentStripped: 4 },
	{ legacyStripped: -1, currentStripped: undefined }
])(
	'run moves legacy context and preserves active transcript state (%j)',
	async ({ legacyStripped, currentStripped }) => {
		vi.useFakeTimers();
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const { threadId: activeThreadId } = await seedOwnedThread(t);

		const oldContext = {
			contextSummary: 'Covered work',
			contextSummaryPartCount: 0,
			contextSummaryHandoffKey: 'old-handoff',
			reasoningStrippedThroughPartNumber: legacyStripped
		};

		const newContext = {
			contextSummary: 'Newer summary',
			contextSummaryPartCount: 5,
			contextSummaryHandoffKey: 'new-handoff',
			reasoningStrippedThroughPartNumber: currentStripped
		};

		await t.run(async (ctx) => {
			await ctx.db.patch('threadRecords', threadId, oldContext);
			await ctx.db.patch('threadRecords', activeThreadId, oldContext);
			const state = await getOrCreateTranscriptState(ctx, activeThreadId);
			await ctx.db.patch('threadTranscriptStates', state._id, {
				...newContext,
				totalParts: 7
			});
		});

		const before = await asUser.query(api.transcript.getState, { threadId });
		await t.mutation(internal.migrations.run, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const [migrated, active, thread] = await t.run((ctx) =>
			Promise.all([
				getTranscriptState(ctx, threadId),
				getTranscriptState(ctx, activeThreadId),
				ctx.db.get('threadRecords', threadId)
			])
		);

		expect(migrated).toMatchObject({ ...oldContext, totalParts: 0 });
		expect(active).toMatchObject({
			...newContext,
			reasoningStrippedThroughPartNumber: currentStripped ?? legacyStripped,
			totalParts: 7
		});

		for (const field of Object.keys(oldContext)) expect(thread).not.toHaveProperty(field);
		expect(await asUser.query(api.transcript.getState, { threadId })).toEqual(before);
		vi.useRealTimers();
	}
);

test('run moves tier grants to users, strips projection fields and empties retired billing tables', async () => {
	vi.useFakeTimers();
	const t = initConvexTest();

	const { grantUserId, revokedUserId, paidId, checkId } = await t.run(async (ctx) => {
		const checkId = await ctx.scheduler.runAfter(
			DAY,
			internal.billingAudit.deleteWebhookEvents,
			{}
		);

		const grantUserId = await insertUser(ctx, 'grant');
		await ctx.db.insert('subscriptions', { userId: 'grant', tier: 'pro', status: 'active' });
		const revokedUserId = await insertUser(ctx, 'revoked');
		await ctx.db.insert('subscriptions', {
			userId: 'revoked',
			tier: 'max',
			status: 'cancelled',
			eventAt: 2
		});
		await ctx.db.insert('subscriptions', {
			userId: 'revoked',
			tier: 'pro',
			status: 'active',
			eventAt: 1
		});
		await ctx.db.insert('subscriptions', { userId: 'bootstrap', tier: 'free', status: 'active' });
		await ctx.db.insert('subscriptionReconciliations', { subscriptionId: 'retired' });
		await ctx.db.insert('supersededSubscriptions', { dodoSubscriptionId: 'sub_retired' });
		await ctx.db.insert('billingCheckoutSessions', { attemptId: 'retired' });
		await ctx.db.insert('billingCheckoutAttempts', { attemptId: 'retired' });
		await ctx.db.insert('dodoPricingCache', { productId: 'prod_retired' });

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

		return { grantUserId, revokedUserId, paidId, checkId };
	});

	await t.mutation(internal.migrations.run, {});

	for (let step = 0; step < 30; step += 1) {
		vi.advanceTimersByTime(1);
		await t.finishInProgressScheduledFunctions();
	}

	const state = await t.run(async (ctx) => ({
		grantUser: await ctx.db.get('users', grantUserId),
		revokedUser: await ctx.db.get('users', revokedUserId),
		subscriptions: await ctx.db.query('subscriptions').collect(),
		paid: await ctx.db.get('subscriptions', paidId),
		check: await ctx.db.system.get('_scheduled_functions', checkId),
		retired: [
			...(await ctx.db.query('subscriptionReconciliations').collect()),
			...(await ctx.db.query('supersededSubscriptions').collect()),
			...(await ctx.db.query('billingCheckoutSessions').collect()),
			...(await ctx.db.query('billingCheckoutAttempts').collect()),
			...(await ctx.db.query('dodoPricingCache').collect())
		]
	}));

	expect(state.grantUser?.grantedTier).toBe('pro');
	expect(state.revokedUser).not.toHaveProperty('grantedTier');
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

test('run backfills missing completion providers as spikonado', async () => {
	vi.useFakeTimers();
	const t = initConvexTest();
	const { threadId } = await seedOwnedThread(t);

	await t.mutation(internal.migrations.run, {});
	await t.finishAllScheduledFunctions(vi.runAllTimers);

	const [thread, run] = await t.run(async (ctx) =>
		Promise.all([
			ctx.db.get('threadRecords', threadId),
			ctx.db
				.query('runs')
				.withIndex('by_threadId', (q) => q.eq('threadId', threadId))
				.unique()
		])
	);

	expect(thread?.completionProvider).toBe('spikonado');
	expect(run?.completionProvider).toBe('spikonado');
	vi.useRealTimers();
});

test('run removes the retired conversation sharing preference', async () => {
	vi.useFakeTimers();
	const t = initConvexTest();

	const preferencesId = await t.run((ctx) =>
		ctx.db.insert('uiPreferences', {
			userId: 'user-1',
			theme: 'dark',
			shareConversationContent: true
		})
	);

	await t.mutation(internal.migrations.run, {});
	await t.finishAllScheduledFunctions(vi.runAllTimers);

	const preferences = await t.run((ctx) => ctx.db.get('uiPreferences', preferencesId));
	expect(preferences).not.toHaveProperty('shareConversationContent');
	expect(preferences?.theme).toBe('dark');
	vi.useRealTimers();
});
