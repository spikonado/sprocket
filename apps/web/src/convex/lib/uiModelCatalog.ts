import type { UsagePolicy } from '@convex/lib/models';
import type { SubscriptionTier } from '@convex/lib/tiers';

/** Ids are opaque so gateway catalogs can add models. */
export type CatalogModel = {
	id: string;
	label: string;
	provider: string;
	supportsImages: boolean;
	contextWindowTokens: number;
	autoCompactTokenLimit: number;
	reasoningEfforts: readonly string[];
	defaultReasoningEffort: string;
	serviceTiers: readonly string[];
	usagePolicy?: UsagePolicy;
};

/** Shape of `sprocket` from `GET /api/v1/models`. */
export type ModelCatalog = {
	defaultModelId: string;
	defaultReasoningEffort: string;
	defaultServiceTier: string;
	models: readonly CatalogModel[];
	tierAllowedModels: Readonly<Record<SubscriptionTier, readonly string[]>>;
	tierAllowedServiceTiers: Readonly<Record<SubscriptionTier, readonly string[]>>;
	modelLockUpgradeMessage: string;
	serviceTierLockUpgradeMessage: string;
	protocolVersion?: number;
	catalogVersion?: string;
};
