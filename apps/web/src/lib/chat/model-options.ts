import {
	modelDefinitions,
	type ModelProvider,
	type SupportedModelId,
	type SupportedReasoningEffort,
	type SupportedServiceTier
} from '$convex/lib/models';

export type ModelSelectorOption = {
	id: SupportedModelId;
	label: string;
	provider: ModelProvider;
};

export const modelOptions: ModelSelectorOption[] = modelDefinitions.map(
	({ id, label, provider }) => ({ id, label, provider })
);

export const reasoningEffortLabels: Record<SupportedReasoningEffort, string> = {
	none: 'None',
	low: 'Low',
	medium: 'Medium',
	high: 'High',
	xhigh: 'Extra High',
	max: 'Max'
};

export const serviceTierLabels: Record<SupportedServiceTier, string> = {
	standard: 'Standard',
	fast: 'Fast'
};
