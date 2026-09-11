export const reasoningEffortIds = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type SupportedReasoningEffort = (typeof reasoningEffortIds)[number];
export type UsagePolicy = 'unlimited';

/** Fallback before the live gateway catalog loads. */
export const defaultModelId = 'gpt-5.6-sol' as const;
export const defaultReasoningEffort: SupportedReasoningEffort = 'high';
