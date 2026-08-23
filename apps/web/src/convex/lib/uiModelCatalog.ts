import type {
	CatalogModel,
	UsagePolicy,
	SupportedModelId,
	SupportedReasoningEffort,
	SupportedServiceTier
} from '@convex/lib/models';
import type { SubscriptionTier } from '@convex/lib/tiers';

export type { CatalogModel };

/** Catalog model extended with usage policy when the query asks for it. */
export type CatalogModelWithUsagePolicy = CatalogModel & { usagePolicy?: UsagePolicy };

/** Shape returned by `modelCatalog.get` — shared by Convex and the web client. */
export type ModelCatalog = {
	defaultModelId: SupportedModelId;
	defaultReasoningEffort: SupportedReasoningEffort;
	defaultServiceTier: SupportedServiceTier;
	models: readonly CatalogModelWithUsagePolicy[];
	tierAllowedModels: Readonly<Record<SubscriptionTier, readonly SupportedModelId[]>>;
	tierAllowedServiceTiers: Readonly<Record<SubscriptionTier, readonly SupportedServiceTier[]>>;
	modelLockUpgradeMessage: string;
	serviceTierLockUpgradeMessage: string;
};
