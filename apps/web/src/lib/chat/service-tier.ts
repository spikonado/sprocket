import type { ServiceTier } from '@convex/lib/validators';
import type { CatalogModel } from './model-catalog';

export type { ServiceTier };

/** Tiers shown as speed switches; turning every switch off selects `standard`. */
export function speedTiers(model: CatalogModel): ServiceTier[] {
	return model.serviceTiers.filter((tier) => tier !== 'standard');
}

/** Without a catalog model the saved tier is kept, so an unavailable catalog does not reset it. */
export function normalizeServiceTier(
	tier: ServiceTier,
	model: CatalogModel | undefined
): ServiceTier {
	return !model || model.serviceTiers.includes(tier) ? tier : 'standard';
}

export function serviceTierLabel(tier: ServiceTier): string {
	return { standard: 'Standard', fast: 'Fast', ultrafast: 'Ultrafast' }[tier];
}
