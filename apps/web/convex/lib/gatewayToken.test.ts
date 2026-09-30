import { describe, expect, it } from 'vitest';
import { MAX_QUESTION_TIMEOUT_MS } from '@convex/lib/agentQuestions';
import { GATEWAY_TOKEN_PRIOR_WORK_MS, GATEWAY_TOKEN_TTL_MS } from '@convex/lib/gatewayProtocol';
import { mintGatewayToken, verifyGatewayToken } from '@convex/lib/gatewayToken';

const secret = 'test-gateway-token-secret';

describe('gateway token', () => {
	it('round-trips a valid token and rejects expiry and tampering', async () => {
		const payload = {
			v: 1 as const,
			userId: 'user_alice',
			exp: Date.now() + 60_000
		};
		const token = await mintGatewayToken(secret, payload);
		const verified = await verifyGatewayToken(secret, token);
		expect(verified).toEqual(payload);

		await expect(verifyGatewayToken(secret, `${token}x`)).rejects.toThrow('Invalid gateway token.');
		await expect(verifyGatewayToken(secret, token, payload.exp + 1)).rejects.toThrow(
			'Gateway token expired.'
		);
	});

	it('outlives a max-length ask wait after prior work', () => {
		expect(GATEWAY_TOKEN_TTL_MS).toBeGreaterThanOrEqual(
			MAX_QUESTION_TIMEOUT_MS + GATEWAY_TOKEN_PRIOR_WORK_MS
		);
	});
});
