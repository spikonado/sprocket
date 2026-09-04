export const reasoningEffortIds = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const serviceTierIds = ['standard', 'fast'] as const;

export type SupportedReasoningEffort = (typeof reasoningEffortIds)[number];
export type SupportedServiceTier = (typeof serviceTierIds)[number];
export type UsagePolicy = 'unlimited';

/** Fallback before the live gateway catalog loads. */
export const defaultModelId = 'deepseek-v4-pro-0813' as const;
export const defaultReasoningEffort: SupportedReasoningEffort = 'max';
export const defaultServiceTier: SupportedServiceTier = 'standard';
