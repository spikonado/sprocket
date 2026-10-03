export const reasoningEffortIds = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type SupportedReasoningEffort = (typeof reasoningEffortIds)[number];

export type UsagePolicy = 'unlimited';

/** Fallback before the live gateway catalog loads. */
export const defaultModelId = 'gpt-5.6-sol' as const;

export const defaultReasoningEffort: SupportedReasoningEffort = 'high';

export function normalizeTaskTimeoutMs(timeoutMs: number | undefined): number | undefined {
	if (timeoutMs === undefined) return undefined;

	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
		throw new Error('Timeout must be a non-negative number of milliseconds.');
	}

	return Math.max(1, Math.floor(timeoutMs));
}
