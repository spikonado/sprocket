export const reasoningEffortIds = ['low', 'medium', 'high', 'xhigh'] as const;
export const modelIds = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex'] as const;
export const defaultModelId = 'gpt-5.4' as const;
export const defaultReasoningEffort = 'medium' as const;

export type SupportedModelId = (typeof modelIds)[number];
export type SupportedReasoningEffort = (typeof reasoningEffortIds)[number];

type SelectorOption<T extends string> = {
	id: T;
	label: string;
	triggerLabel?: string;
};

export type ModelOption = SelectorOption<SupportedModelId>;
export type ReasoningEffortOption = SelectorOption<SupportedReasoningEffort>;

export const modelOptions: ModelOption[] = [
	{ id: 'gpt-5.5', label: 'GPT-5.5' },
	{ id: 'gpt-5.4', label: 'GPT-5.4 (default)', triggerLabel: 'GPT-5.4' },
	{ id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
	{ id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' }
];

export const reasoningEffortOptions: ReasoningEffortOption[] = [
	{ id: 'low', label: 'Low' },
	{ id: 'medium', label: 'Medium (default)', triggerLabel: 'Medium' },
	{ id: 'high', label: 'High' },
	{ id: 'xhigh', label: 'Extra High' }
];
