import type { UsagePolicy } from '@convex/lib/models';

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
	/** Tier ids are gateway-owned; keys are dynamic strings. */
	tierAllowedModels: Readonly<Record<string, readonly string[]>>;
	tierAllowsFastMode: Readonly<Record<string, boolean>>;
	modelLockUpgradeMessage: string;
	fastModeLockUpgradeMessage: string;
	protocolVersion?: number;
	catalogVersion?: string;
};
