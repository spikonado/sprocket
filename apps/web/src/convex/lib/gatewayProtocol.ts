export const GATEWAY_PROTOCOL_VERSION = 1;
/** Slack for work before ask_question. The completion client is minted once per agent run. */
export const GATEWAY_TOKEN_PRIOR_WORK_MS = 12 * 60 * 60 * 1000;
/** 24h max question wait plus prior-work slack. Kept here so protocol stays independent of agentQuestions. */
export const GATEWAY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000 + GATEWAY_TOKEN_PRIOR_WORK_MS;
export const GATEWAY_TOKEN_PREFIX = 'sgt1';
/** Public OpenAI-compatible routes live under this prefix on the AI gateway origin. */
export const GATEWAY_API_PREFIX = '/api';

export const CATALOG_UNAVAILABLE_MESSAGE = 'Model catalog is unavailable.';
export const GATEWAY_NOT_CONFIGURED_MESSAGE = 'AI gateway is not configured.';
