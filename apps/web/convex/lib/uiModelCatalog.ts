import type { UsagePolicy } from '@convex/lib/models';
import type { ServiceTier } from '@convex/lib/validators';

/** The provider's own API list prices in USD per million tokens. */
export type DirectApiPricing = {
	input: number;
	cacheRead: number;
	/** Keyed by cache lifetime, matching each usage row's `cacheWriteTtl`. */
	cacheWrite: Readonly<Record<string, number>>;
	output: number;
	fastMultiplier: number;
	ultrafastMultiplier?: number;
	longContext: { inputMultiplier: number; outputMultiplier: number } | null;
};

export type CatalogModel = {
	id: string;
	label: string;
	provider: string;
	supportsImages: boolean;
	contextWindowTokens: number;
	autoHandoffTokenLimit: number;
	reasoningEfforts: readonly string[];
	defaultReasoningEffort: string;
	serviceTiers: readonly ServiceTier[];
	usagePolicy?: UsagePolicy;
	directApiPricing?: DirectApiPricing | null;
};

export type ModelCatalog = {
	defaultModelId: string;
	defaultReasoningEffort: string;
	models: readonly CatalogModel[];
	protocolVersion?: number;
	catalogVersion?: string;
};
