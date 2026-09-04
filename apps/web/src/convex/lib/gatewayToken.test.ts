import { describe, expect, it } from 'vitest';
import { GATEWAY_TOKEN_TTL_MS } from '@convex/lib/gatewayProtocol';
import { mintGatewayToken, verifyGatewayToken } from '@convex/lib/gatewayToken';

const secret = 'test-gateway-token-secret';
/** Keep in sync with MAX_QUESTION_TIMEOUT_MS in agentQuestions.ts. */
const MAX_QUESTION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

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

	it('outlives the maximum ask-question wait', () => {
		expect(GATEWAY_TOKEN_TTL_MS).toBeGreaterThan(MAX_QUESTION_TIMEOUT_MS);
	});
});
