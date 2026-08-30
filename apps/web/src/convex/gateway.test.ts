import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import {
	createQueuedRun,
	initConvexTest,
	seedOwnedThread,
	subjectTokenIdentifier
} from './test.setup';

const gatewayUrl = 'https://preview.gateway.example';
const tokenSecret = 'test-gateway-token-secret';

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
		const { asUser, threadId, subject } = await seedOwnedThread(t);
		const executionSecret = 'gateway-secret';
		const created = await asUser.action(api.agentRuntime.createGatewayRun, {
			submissionId: 'gateway-run',
			threadId,
			prompt: 'Ship it',
			imageUploadIds: [],
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			serviceTier: 'standard',
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
		expect(quota).toMatchObject({
			userId: subjectTokenIdentifier(subject),
			tier: 'admin',
			exhausted: false
		});
		await expect(
			t.mutation(api.gateway.consumeQuota, { token: credential.token, units: 12 })
		).resolves.toBeNull();
		await expect(t.mutation(api.gateway.checkQuota, { token: 'sgt1.not.a.token' })).rejects.toThrow(
			'Invalid gateway token.'
		);
	}, 15_000);

	it('snapshots gateway transport on new runs', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const created = await createQueuedRun(t, asUser, threadId, 'gateway-run', 'gateway-secret');
		expect(created.created).toBe(true);
		const run = await t.run(async (ctx) => ctx.db.get('runs', created.runId));
		expect(run?.completionTransport).toBe('gateway');
		expect(run?.gatewayProtocolVersion).toBe(1);
	});
});
