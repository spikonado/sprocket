export const reasoningEffortIds = ['low', 'medium', 'high', 'xhigh'] as const;
export const modelIds = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex'] as const;
export const defaultModelId = 'gpt-5.4' as const;
export const defaultReasoningEffort = 'medium' as const;

export type SupportedModelId = (typeof modelIds)[number];
export type SupportedReasoningEffort = (typeof reasoningEffortIds)[number];

export type ModelOption = {
	id: SupportedModelId;
	label: string;
	triggerLabel?: string;
};

export type ReasoningEffortOption = {
	id: SupportedReasoningEffort;
	label: string;
	triggerLabel?: string;
};

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

export function getModelLabel(modelId: SupportedModelId | string) {
	const matchingOption = modelOptions.find((option) => option.id === modelId);
	return matchingOption?.triggerLabel ?? matchingOption?.label ?? modelId;
}

export function getReasoningEffortLabel(reasoningEffort: SupportedReasoningEffort | string) {
	const matchingOption = reasoningEffortOptions.find((option) => option.id === reasoningEffort);
	return matchingOption?.triggerLabel ?? matchingOption?.label ?? reasoningEffort;
}
