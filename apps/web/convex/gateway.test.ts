import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';
import type { ConvexTestInstance } from './test.setup';

const gatewayUrl = 'https://preview.gateway.example';

const tokenSecret = 'test-gateway-token-secret';

const UNITS_PER_DOLLAR = 1_000_000_000;

/** Operator-managed tiers; quota checks throw when the table is empty. */
async function seedTiers(t: ConvexTestInstance): Promise<void> {
	await t.run(async (ctx) => {
		const tiers = [
			{
				tierId: 'free',
				label: 'Free',
				weekly: 5 * UNITS_PER_DOLLAR,
				monthly: 15 * UNITS_PER_DOLLAR
			},
			{
				tierId: 'pro',
				label: 'Pro',
				weekly: 25 * UNITS_PER_DOLLAR,
				monthly: 75 * UNITS_PER_DOLLAR
			},
			{
				tierId: 'max',
				label: 'Max',
				weekly: 170 * UNITS_PER_DOLLAR,
				monthly: 500 * UNITS_PER_DOLLAR
			}
		];

		for (const tier of tiers) {
			await ctx.db.insert('tiers', tier);
		}
	});
}

describe('gateway quota', () => {
	beforeEach(() => {
		vi.stubEnv('MODEL_GATEWAY_URL', gatewayUrl);
		vi.stubEnv('MODEL_GATEWAY_TOKEN_SECRET', tokenSecret);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('mints a user credential and reports remaining quota', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const { asUser, threadId, subject } = await seedOwnedThread(t);
		const executionSecret = 'gateway-secret';

		const created = await asUser.action(api.agentRuntime.createGatewayRun, {
			submissionId: 'gateway-run',
			threadId,
			prompt: 'Ship it',
			storageIds: [],
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			fastMode: false,
			executionSecret,
			agentVersion: '0.3.2'
		});

		expect(created.gatewayUrl).toBe(gatewayUrl);
		expect(created.protocolVersion).toBe(1);

		await asUser.mutation(api.agentRuntime.start, {
			runId: created.runId,
			claimId: 'claim-gateway',
			executionSecret
		});

		const credential = await t.mutation(api.agentRuntime.issueGatewayCredential, {
			runId: created.runId,
			claimId: 'claim-gateway',
			executionSecret
		});

		const quota = await t.mutation(api.gateway.checkQuota, { token: credential.token });
		expect(quota).toMatchObject({ userId: subject, tier: 'free', exhausted: false });
		await expect(
			t.mutation(api.gateway.consumeQuota, { token: credential.token, units: 12 })
		).resolves.toBeNull();
		await expect(t.mutation(api.gateway.checkQuota, { token: 'sgt1.not.a.token' })).rejects.toThrow(
			'Invalid gateway token.'
		);
	}, 15_000);

	it('rejects invalid quota charges without touching usage', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const { asUser, threadId, subject } = await seedOwnedThread(t);
		const executionSecret = 'gateway-secret';

		const created = await asUser.action(api.agentRuntime.createGatewayRun, {
			submissionId: 'gateway-run-invalid-units',
			threadId,
			prompt: 'Ship it',
			storageIds: [],
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			fastMode: false,
			executionSecret,
			agentVersion: '0.3.2'
		});

		await asUser.mutation(api.agentRuntime.start, {
			runId: created.runId,
			claimId: 'claim-gateway-invalid-units',
			executionSecret
		});

		const credential = await t.mutation(api.agentRuntime.issueGatewayCredential, {
			runId: created.runId,
			claimId: 'claim-gateway-invalid-units',
			executionSecret
		});

		const before = await asUser.query(api.usage.getMyUsage, {});

		const beforeWeekly = before.meters
			.find((meter) => meter.id === 'modelUsage')
			?.windows.find((window) => window.period === 'weekly')?.used;

		expect(beforeWeekly).toBe(0);

		for (const units of [Number.NaN, Number.POSITIVE_INFINITY, -5, 2_000_000_000_000]) {
			await expect(
				t.mutation(api.gateway.consumeQuota, { token: credential.token, units })
			).rejects.toThrow();
		}

		const quota = await t.mutation(api.gateway.checkQuota, { token: credential.token });
		expect(quota).toMatchObject({ userId: subject, exhausted: false });
		const after = await asUser.query(api.usage.getMyUsage, {});

		const afterWeekly = after.meters
			.find((meter) => meter.id === 'modelUsage')
			?.windows.find((window) => window.period === 'weekly')?.used;

		expect(afterWeekly).toBe(beforeWeekly);
	}, 15_000);

	it('refuses to create a gateway run when usage is exhausted', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const { asUser, threadId, subject } = await seedOwnedThread(t);
		await t.mutation(internal.lib.rateLimits.chargeUsageUnits, {
			userId: subject,
			count: 6 * UNITS_PER_DOLLAR
		});

		await expect(
			asUser.action(api.agentRuntime.createGatewayRun, {
				submissionId: 'gateway-run-exhausted',
				threadId,
				prompt: 'Ship it',
				storageIds: [],
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				fastMode: false,
				executionSecret: 'gateway-exhausted'
			})
		).rejects.toThrow(/model usage limit reached/);

		const runs = await t.run(async (ctx) =>
			ctx.db
				.query('runs')
				.withIndex('by_userId_submissionId', (query) =>
					query.eq('userId', subject).eq('submissionId', 'gateway-run-exhausted')
				)
				.collect()
		);
		expect(runs).toHaveLength(0);
	}, 15_000);

	it('enforces a paid tier when the free tier row is missing', async () => {
		const t = initConvexTest();
		await t.run(async (ctx) => {
			await ctx.db.insert('tiers', {
				tierId: 'pro',
				label: 'Pro',
				weekly: 25 * UNITS_PER_DOLLAR,
				monthly: 75 * UNITS_PER_DOLLAR
			});
		});
		const { asUser, threadId, subject } = await seedOwnedThread(t);
		await t.run(async (ctx) => {
			await ctx.db.insert('subscriptions', {
				userId: subject,
				tier: 'pro',
				status: 'active',
				eventAt: 1
			});
		});
		await t.mutation(internal.lib.rateLimits.chargeUsageUnits, {
			userId: subject,
			count: 26 * UNITS_PER_DOLLAR
		});

		await expect(
			asUser.action(api.agentRuntime.createGatewayRun, {
				submissionId: 'gateway-run-pro-exhausted',
				threadId,
				prompt: 'Ship it',
				storageIds: [],
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				fastMode: false,
				executionSecret: 'gateway-pro-exhausted'
			})
		).rejects.toThrow(/model usage limit reached/);
	}, 15_000);

	it('reconciles an existing submission after quota is exhausted', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const { asUser, threadId, subject } = await seedOwnedThread(t);
		const executionSecret = 'gateway-reconcile-exhausted';
		const request = {
			submissionId: 'gateway-run-reconcile-exhausted',
			threadId,
			prompt: 'Ship it',
			storageIds: [],
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium' as const,
			fastMode: false,
			executionSecret
		};

		const created = await asUser.action(api.agentRuntime.createGatewayRun, request);
		expect(created.created).toBe(true);

		await t.mutation(internal.lib.rateLimits.chargeUsageUnits, {
			userId: subject,
			count: 6 * UNITS_PER_DOLLAR
		});

		const retried = await asUser.action(api.agentRuntime.createGatewayRun, request);
		expect(retried.created).toBe(false);
		expect(retried.runId).toBe(created.runId);
	}, 15_000);

	it('snapshots the gateway protocol on new runs', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const created = await createQueuedRun(t, asUser, threadId, 'gateway-run', 'gateway-secret');
		expect(created.created).toBe(true);
		const run = await t.run(async (ctx) => ctx.db.get('runs', created.runId));
		expect(run?.gatewayProtocolVersion).toBe(1);
	});

	it('does not issue gateway credentials for direct OpenAI runs', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'direct-openai-secret';
		const claimId = 'direct-openai-claim';

		const created = await createQueuedRun(
			t,
			asUser,
			threadId,
			'direct-openai-run',
			executionSecret
		);

		await t.run(async (ctx) => {
			await ctx.db.patch('runs', created.runId, { completionProvider: 'openai' });
		});
		await asUser.mutation(api.agentRuntime.start, {
			runId: created.runId,
			claimId,
			executionSecret
		});

		await expect(
			t.mutation(api.agentRuntime.issueGatewayCredential, {
				runId: created.runId,
				claimId,
				executionSecret
			})
		).rejects.toThrow('Run is not configured to use the Spikonado gateway.');
	});
});
