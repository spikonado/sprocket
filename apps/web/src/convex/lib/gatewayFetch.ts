import { ConvexError } from 'convex/values';
import { env } from '@convex/_generated/server';
import {
	CATALOG_UNAVAILABLE_MESSAGE,
	GATEWAY_API_PREFIX,
	GATEWAY_NOT_CONFIGURED_MESSAGE
} from '@convex/lib/gatewayProtocol';
import { parseGatewayModelsResponse, type GatewayCatalog } from '@convex/lib/gatewayCatalog';
import { isJsonValue } from '@convex/lib/json';

const CATALOG_FETCH_TIMEOUT_MS = 15_000;

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

export async function fetchGatewayCatalog(gatewayUrl = modelGatewayUrl()): Promise<GatewayCatalog> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CATALOG_FETCH_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(`${gatewayUrl}${GATEWAY_API_PREFIX}/v1/models`, {
			method: 'GET',
			headers: { accept: 'application/json' },
			signal: controller.signal
		});
	} catch {
		throw new ConvexError(CATALOG_UNAVAILABLE_MESSAGE);
	} finally {
		clearTimeout(timer);
	}
	if (!response.ok) {
		throw new ConvexError(CATALOG_UNAVAILABLE_MESSAGE);
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new ConvexError(CATALOG_UNAVAILABLE_MESSAGE);
	}
	if (!isJsonValue(payload)) {
		throw new ConvexError(CATALOG_UNAVAILABLE_MESSAGE);
	}
	try {
		return parseGatewayModelsResponse(payload);
	} catch (error) {
		if (error instanceof Error && error.message.includes('Unsupported protocol version')) {
			throw new ConvexError(error.message);
		}
		throw new ConvexError(CATALOG_UNAVAILABLE_MESSAGE);
	}
}
