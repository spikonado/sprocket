import type { SupportedModelId, SupportedReasoningEffort } from '$convex/lib/models';

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
