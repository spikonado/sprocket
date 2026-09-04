export const GATEWAY_PROTOCOL_VERSION = 1;
/** Must outlive ask_question's 24h max wait. The completion client is minted once per agent run. */
export const GATEWAY_TOKEN_TTL_MS = 25 * 60 * 60 * 1000;
export const GATEWAY_TOKEN_PREFIX = 'sgt1';
/** Public OpenAI-compatible routes live under this prefix on the AI gateway origin. */
export const GATEWAY_API_PREFIX = '/api';

export const CATALOG_UNAVAILABLE_MESSAGE = 'Model catalog is unavailable.';
export const GATEWAY_NOT_CONFIGURED_MESSAGE = 'AI gateway is not configured.';
