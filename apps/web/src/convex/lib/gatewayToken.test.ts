import { describe, expect, it } from 'vitest';
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
});
