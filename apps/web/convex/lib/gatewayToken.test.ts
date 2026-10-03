import { describe, expect, it } from 'vitest';
import { GATEWAY_TOKEN_PRIOR_WORK_MS, GATEWAY_TOKEN_TTL_MS } from '@convex/lib/gatewayProtocol';
import { mintGatewayToken, verifyGatewayToken } from '@convex/lib/gatewayToken';

const secret = 'test-gateway-token-secret';

const MAX_GATEWAY_WAIT_MS = 270_000;

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

	it('outlives a maximum-length wait after prior work', () => {
		expect(GATEWAY_TOKEN_TTL_MS).toBeGreaterThanOrEqual(
			MAX_GATEWAY_WAIT_MS + GATEWAY_TOKEN_PRIOR_WORK_MS
		);
	});
});
