import type { SubscriptionTier } from '$convex/lib/tiers';
import type { CatalogModel, ModelCatalog } from '$convex/lib/uiModelCatalog';

export type { CatalogModel, ModelCatalog };
export type CatalogModelId = CatalogModel['id'];

export type ModelSelectorOption = {
	id: CatalogModelId;
	label: string;
	provider: string;
	locked?: boolean;
	lockTooltip?: string;
};

export type ServiceTierSelectorOption = {
	id: string;
	label: string;
	locked?: boolean;
	lockTooltip?: string;
};

export function getCatalogModel(
	catalog: ModelCatalog,
	modelId: CatalogModelId
): CatalogModel | undefined {
	return catalog.models.find((model) => model.id === modelId);
}

export function isModelAllowedForTier(
	catalog: ModelCatalog,
	tier: SubscriptionTier,
	modelId: CatalogModelId
): boolean {
	return (catalog.tierAllowedModels[tier] ?? []).includes(modelId);
}

export function resolveModelForTier(
	catalog: ModelCatalog,
	tier: SubscriptionTier,
	modelId: CatalogModelId
): CatalogModelId {
	if (isModelAllowedForTier(catalog, tier, modelId)) return modelId;
	return catalog.tierAllowedModels[tier]?.[0] ?? catalog.defaultModelId;
}

export function isServiceTierAllowedForTier(
	catalog: ModelCatalog,
	tier: SubscriptionTier,
	serviceTier: string
): boolean {
	return (catalog.tierAllowedServiceTiers[tier] ?? []).includes(serviceTier);
}

export function serviceTiersForModelAndTier(
	catalog: ModelCatalog,
	tier: SubscriptionTier,
	model: CatalogModel
): readonly string[] {
	return model.serviceTiers.filter((serviceTier) =>
		isServiceTierAllowedForTier(catalog, tier, serviceTier)
	);
}

export function serviceTierOptionsForModelAndTier(
	catalog: ModelCatalog,
	tier: SubscriptionTier,
	model: CatalogModel
): ServiceTierSelectorOption[] {
	return model.serviceTiers.map((serviceTier) => {
		const option: ServiceTierSelectorOption = {
			id: serviceTier,
			label: serviceTierLabel(serviceTier)
		};
		if (isServiceTierAllowedForTier(catalog, tier, serviceTier)) return option;
		return {
			...option,
			locked: true,
			lockTooltip: catalog.serviceTierLockUpgradeMessage
		};
	});
}

export function modelOptionsForTier(
	catalog: ModelCatalog,
	tier: SubscriptionTier
): ModelSelectorOption[] {
	const unlocked: ModelSelectorOption[] = [];
	const locked: ModelSelectorOption[] = [];
	for (const model of catalog.models) {
		const option = { id: model.id, label: model.label, provider: model.provider };
		if (isModelAllowedForTier(catalog, tier, model.id)) {
			unlocked.push(option);
		} else {
			locked.push({
				...option,
				locked: true,
				lockTooltip: catalog.modelLockUpgradeMessage
			});
		}
	}
	return [...unlocked, ...locked];
}

/** Prefer a known label; fall back to the raw id so newer catalog values still render. */
export function reasoningEffortLabel(effort: string): string {
	switch (effort) {
		case 'none':
			return 'None';
		case 'low':
			return 'Low';
		case 'medium':
			return 'Medium';
		case 'high':
			return 'High';
		case 'xhigh':
			return 'Extra High';
		case 'max':
			return 'Max';
		default:
			return effort;
	}
}

export function serviceTierLabel(tier: string): string {
	switch (tier) {
		case 'standard':
			return 'Standard';
		case 'fast':
			return 'Fast';
		default:
			return tier;
	}
}
