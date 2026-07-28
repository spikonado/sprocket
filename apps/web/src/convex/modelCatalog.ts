import {
	defaultModelId,
	defaultReasoningEffort,
	defaultServiceTier,
	modelDefinitions
} from '@convex/lib/models';
import {
	modelLockUpgradeMessage,
	serviceTierLockUpgradeMessage,
	tierAllowedModels,
	tierAllowedServiceTiers
} from '@convex/lib/tiers';
import type { ModelCatalog } from '@convex/lib/uiModelCatalog';
import { query } from './_generated/server';

/**
 * UI-facing catalog so clients pick up new models from Convex deploys without a client update.
 * Intentionally unauthenticated: the catalog is not secret (model ids/labels/limits only).
 * Entitlements are enforced server-side on send/usage paths.
 */
export const get = query({
	args: {},
	handler: async () =>
		({
			defaultModelId,
			defaultReasoningEffort,
			defaultServiceTier,
			// Omit server-only pricing weights from the UI catalog.
			models: modelDefinitions.map((definition) => {
				const { usageWeights, ...model } = definition;
				void usageWeights;
				return model;
			}),
			tierAllowedModels,
			tierAllowedServiceTiers,
			modelLockUpgradeMessage,
			serviceTierLockUpgradeMessage
		}) satisfies ModelCatalog
});
