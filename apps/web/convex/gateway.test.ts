import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@convex/_generated/api';
import { createQueuedRun, initConvexTest, seedOwnedThread, seedTiers } from './test.setup';

const gatewayUrl = 'https://preview.gateway.example';

const tokenSecret = 'test-gateway-token-secret';

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
			completionProvider: 'spikonado',
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

	it('mints credentials when usage is exhausted so the gateway can validate the request first', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		await t.run(async (ctx) => {
			const free = await ctx.db
				.query('tiers')
				.withIndex('by_tierId', (q) => q.eq('tierId', 'free'))
				.unique();

			if (!free) throw new Error('Missing Free tier.');
			await ctx.db.patch('tiers', free._id, { monthly: 0 });
		});
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'gateway-secret';
		const claimId = 'claim-gateway-exhausted';

		const created = await createQueuedRun(
			t,
			asUser,
			threadId,
			'gateway-run-exhausted',
			executionSecret
		);

		await asUser.mutation(api.agentRuntime.start, {
			runId: created.runId,
			claimId,
			executionSecret
		});

		const credential = await t.mutation(api.agentRuntime.issueGatewayCredential, {
			runId: created.runId,
			claimId,
			executionSecret
		});

		const quota = await t.mutation(api.gateway.checkQuota, { token: credential.token });
		expect(quota).toMatchObject({ exhausted: true });
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
			completionProvider: 'spikonado',
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

		const before = await asUser.query(api.usage.getMyUsage, { now: Date.now() });
		const usedBefore = before.meters.find((meter) => meter.id === 'modelUsage')?.used;
		expect(usedBefore).toBe(0);

		for (const units of [Number.NaN, Number.POSITIVE_INFINITY, -5, 2_000_000_000_000]) {
			await expect(
				t.mutation(api.gateway.consumeQuota, { token: credential.token, units })
			).rejects.toThrow();
		}

		const quota = await t.mutation(api.gateway.checkQuota, { token: credential.token });
		expect(quota).toMatchObject({ userId: subject, exhausted: false });
		const after = await asUser.query(api.usage.getMyUsage, { now: Date.now() });
		expect(after.meters.find((meter) => meter.id === 'modelUsage')?.used).toBe(usedBefore);
	}, 15_000);

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
