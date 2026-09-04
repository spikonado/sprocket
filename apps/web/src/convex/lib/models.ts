export const reasoningEffortIds = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const serviceTierIds = ['standard', 'fast'] as const;

export type SupportedReasoningEffort = (typeof reasoningEffortIds)[number];
export type SupportedServiceTier = (typeof serviceTierIds)[number];
export type UsagePolicy = 'unlimited';

/** Fallback before the live gateway catalog loads. */
export const defaultModelId = 'deepseek-v4-pro-0813' as const;
export const defaultReasoningEffort: SupportedReasoningEffort = 'max';
export const defaultServiceTier: SupportedServiceTier = 'standard';

function isSupportedReasoningEffort(value: string): value is SupportedReasoningEffort {
	return reasoningEffortIds.some((effort) => effort === value);
}

function isSupportedServiceTier(value: string): value is SupportedServiceTier {
	return serviceTierIds.some((tier) => tier === value);
}

export function coercePersistedServiceTier(serviceTier: string): SupportedServiceTier {
	return isSupportedServiceTier(serviceTier) ? serviceTier : defaultServiceTier;
}

export function coercePersistedReasoningEffort(
	reasoningEffort: SupportedReasoningEffort
): SupportedReasoningEffort {
	return isSupportedReasoningEffort(reasoningEffort) ? reasoningEffort : defaultReasoningEffort;
}
