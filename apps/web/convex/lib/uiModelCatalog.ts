import type { UsagePolicy } from '@convex/lib/models';

/** The provider's own API list prices in USD per million tokens. */
export type DirectApiPricing = {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	fastMultiplier: number;
	longContext: { inputMultiplier: number; outputMultiplier: number } | null;
};

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
	directApiPricing?: DirectApiPricing | null;
};

/** UI catalog mapped from `sprocket` on `GET /api/v1/models`. */
export type ModelCatalog = {
	defaultModelId: string;
	defaultReasoningEffort: string;
	models: readonly CatalogModel[];
	protocolVersion?: number;
	catalogVersion?: string;
};
