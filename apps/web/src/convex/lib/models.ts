export const reasoningEffortIds = ['low', 'medium', 'high', 'xhigh'] as const;
export const modelIds = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex'] as const;
export const defaultModelId = 'gpt-5.4' as const;
export const defaultReasoningEffort = 'medium' as const;

export type SupportedModelId = (typeof modelIds)[number];
export type SupportedReasoningEffort = (typeof reasoningEffortIds)[number];
