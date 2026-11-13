import type { ProviderOrderEntry } from '@convex/lib/providerOrder';
import type { ServiceTier } from '@convex/lib/validators';
import type { CatalogModel } from './model-catalog';

export type { ServiceTier };

export function isDirectOpenAIByok(
	model: CatalogModel,
	order: readonly ProviderOrderEntry[],
	openaiConfigured: boolean
): boolean {
	if (model.provider !== 'openai' || !openaiConfigured) return false;

	// The UI catalog cannot rule out earlier alternative API routes for this model.
	const first = order.find(
		(entry) => entry.enabled && !['anthropic', 'claude', 'muse'].includes(entry.provider)
	);

	return first?.provider === 'openai';
}

export function availableServiceTiers(
	model: CatalogModel,
	directOpenAIByok: boolean
): ServiceTier[] {
	const tiers: ServiceTier[] = ['standard'];

	if (model.supportsFastMode) tiers.push('fast');

	if (directOpenAIByok && model.byokServiceTiers?.includes('ultrafast')) tiers.push('ultrafast');

	return tiers;
}

export function normalizeServiceTier(
	tier: ServiceTier,
	model: CatalogModel | undefined,
	directOpenAIByok: boolean
): ServiceTier {
	return model && availableServiceTiers(model, directOpenAIByok).includes(tier) ? tier : 'standard';
}

export function serviceTierLabel(tier: ServiceTier): string {
	return { standard: 'Standard', fast: 'Fast', ultrafast: 'Ultrafast' }[tier];
}
