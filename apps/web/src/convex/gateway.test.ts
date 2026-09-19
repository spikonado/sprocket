import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
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
			await ctx.db.insert('tiers', { ...tier, unitsPerDollar: UNITS_PER_DOLLAR });
		}
	});
}

describe('gateway quota', () => {
	beforeEach(() => {
		process.env.MODEL_GATEWAY_URL = gatewayUrl;
		process.env.MODEL_GATEWAY_TOKEN_SECRET = tokenSecret;
	});

	afterEach(() => {
		delete process.env.MODEL_GATEWAY_URL;
		delete process.env.MODEL_GATEWAY_TOKEN_SECRET;
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

	it('snapshots the gateway protocol on new runs', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const created = await createQueuedRun(t, asUser, threadId, 'gateway-run', 'gateway-secret');
		expect(created.created).toBe(true);
		const run = await t.run(async (ctx) => ctx.db.get('runs', created.runId));
		expect(run?.gatewayProtocolVersion).toBe(1);
	});
});
