import type { ModelProvider, SupportedModelId, SupportedServiceTier } from '$convex/lib/models';
import type { SubscriptionTier } from '$convex/lib/tiers';
import type { CatalogModel, ModelCatalog } from '$convex/lib/uiModelCatalog';

export type { CatalogModel, ModelCatalog };
export type CatalogModelId = CatalogModel['id'];

/** Narrow a runtime catalog id for Convex args; server validators remain authoritative. */
export function asSupportedModelId(modelId: CatalogModelId): SupportedModelId {
	return modelId as SupportedModelId;
}

export type ModelSelectorOption = {
	id: CatalogModelId;
	label: string;
	provider: ModelProvider | string;
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

export function serviceTiersForModelAndTier(
	catalog: ModelCatalog,
	tier: SubscriptionTier,
	model: CatalogModel
): readonly SupportedServiceTier[] {
	const allowed = catalog.tierAllowedServiceTiers[tier] ?? [];
	return model.serviceTiers.filter((serviceTier) => allowed.includes(serviceTier));
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

const reasoningEffortLabels: Record<string, string> = {
	none: 'None',
	low: 'Low',
	medium: 'Medium',
	high: 'High',
	xhigh: 'Extra High',
	max: 'Max'
};

const serviceTierLabels: Record<string, string> = {
	standard: 'Standard',
	fast: 'Fast'
};

/** Prefer a known label; fall back to the raw id so newer catalog values still render. */
export function reasoningEffortLabel(effort: string): string {
	return reasoningEffortLabels[effort] ?? effort;
}

export function serviceTierLabel(tier: string): string {
	return serviceTierLabels[tier] ?? tier;
}
