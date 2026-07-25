import type {
	CatalogModel,
	SupportedModelId,
	SupportedReasoningEffort,
	SupportedServiceTier
} from '@convex/lib/models';
import type { SubscriptionTier } from '@convex/lib/tiers';

export type { CatalogModel };

/** Shape returned by `modelCatalog.get` — shared by Convex and the web client. */
export type ModelCatalog = {
	defaultModelId: SupportedModelId;
	defaultReasoningEffort: SupportedReasoningEffort;
	defaultServiceTier: SupportedServiceTier;
	models: readonly CatalogModel[];
	tierAllowedModels: Readonly<Record<SubscriptionTier, readonly SupportedModelId[]>>;
	modelLockUpgradeMessage: string;
};
