import {
	modelDefinitions,
	type ModelProvider,
	type SupportedModelId,
	type SupportedReasoningEffort,
	type SupportedServiceTier
} from '$convex/lib/models';
import {
	isModelAllowedForTier,
	modelLockUpgradeMessage,
	type SubscriptionTier
} from '$convex/lib/tiers';

export type ModelSelectorOption = {
	id: SupportedModelId;
	label: string;
	provider: ModelProvider;
	locked?: boolean;
	lockTooltip?: string;
};

export const modelOptions: ModelSelectorOption[] = modelDefinitions.map(
	({ id, label, provider }) => ({ id, label, provider })
);

export function modelOptionsForTier(tier: SubscriptionTier): ModelSelectorOption[] {
	const unlocked: ModelSelectorOption[] = [];
	const locked: ModelSelectorOption[] = [];
	for (const option of modelOptions) {
		if (isModelAllowedForTier(tier, option.id)) {
			unlocked.push(option);
		} else {
			locked.push({
				...option,
				locked: true,
				lockTooltip: modelLockUpgradeMessage
			});
		}
	}
	return [...unlocked, ...locked];
}

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
