import { ConvexError } from 'convex/values';
import { env } from '@convex/_generated/server';
import { GATEWAY_NOT_CONFIGURED_MESSAGE } from '@convex/lib/gatewayProtocol';

/** Public origin of ai-gateway, e.g. `https://ai-gateway.spikonado.com` (no `/api` suffix). */
export function modelGatewayUrl(): string {
	const url = env.MODEL_GATEWAY_URL?.trim();
	if (!url) throw new ConvexError(GATEWAY_NOT_CONFIGURED_MESSAGE);
	return url.replace(/\/+$/, '');
}

export function modelGatewayTokenSecret(): string {
	const secret = env.MODEL_GATEWAY_TOKEN_SECRET?.trim();
	if (!secret) throw new ConvexError(GATEWAY_NOT_CONFIGURED_MESSAGE);
	return secret;
}
