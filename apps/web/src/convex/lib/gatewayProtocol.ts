export const GATEWAY_PROTOCOL_VERSION = 1;
/** Long enough for a multi-turn agent loop. Claim lease still gates minting. */
export const GATEWAY_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
export const GATEWAY_TOKEN_PREFIX = 'sgt1';
/** Public OpenAI-compatible routes live under this prefix on the AI gateway origin. */
export const GATEWAY_API_PREFIX = '/api';

export const CATALOG_UNAVAILABLE_MESSAGE = 'Model catalog is unavailable.';
export const GATEWAY_NOT_CONFIGURED_MESSAGE = 'AI gateway is not configured.';
