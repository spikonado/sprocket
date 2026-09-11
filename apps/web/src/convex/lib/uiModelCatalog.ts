import type { UsagePolicy } from '@convex/lib/models';
import type { SubscriptionTier } from '@convex/lib/tiers';

/** Ids are opaque so gateway catalogs can add models. */
export type CatalogModel = {
	id: string;
	label: string;
	provider: string;
	supportsImages: boolean;
	contextWindowTokens: number;
	autoHandoffTokenLimit: number;
	reasoningEfforts: readonly string[];
	defaultReasoningEffort: string;
	supportsFastMode: boolean;
	usagePolicy?: UsagePolicy;
};

/** UI catalog mapped from `sprocket` on `GET /api/v1/models`. */
export type ModelCatalog = {
	defaultModelId: string;
	defaultReasoningEffort: string;
	models: readonly CatalogModel[];
	tierAllowedModels: Readonly<Record<SubscriptionTier, readonly string[]>>;
	tierAllowsFastMode: Readonly<Record<SubscriptionTier, boolean>>;
	modelLockUpgradeMessage: string;
	fastModeLockUpgradeMessage: string;
	protocolVersion?: number;
	catalogVersion?: string;
};
