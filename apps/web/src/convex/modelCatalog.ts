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
import { vModelCatalog } from '@convex/lib/docs';
import type { ModelCatalog } from '@convex/lib/uiModelCatalog';
import { query } from './_generated/server';

/**
 * UI-facing catalog so clients pick up new models from Convex deploys without a client update.
 * Intentionally unauthenticated: the catalog is not secret (model ids/labels/limits only).
 * Entitlements are enforced server-side on send/usage paths.
 */
export const get = query({
	args: {},
	returns: vModelCatalog,
	handler: async () => {
		const catalog = {
			defaultModelId,
			defaultReasoningEffort,
			defaultServiceTier,
			// Omit server-only pricing weights from the UI catalog.
			models: modelDefinitions.map((definition) => {
				const { usageWeights, ...model } = definition;
				void usageWeights;
				return {
					...model,
					reasoningEfforts: [...model.reasoningEfforts],
					serviceTiers: [...model.serviceTiers]
				};
			}),
			tierAllowedModels: {
				free: [...tierAllowedModels.free],
				pro: [...tierAllowedModels.pro],
				admin: [...tierAllowedModels.admin]
			},
			tierAllowedServiceTiers: {
				free: [...tierAllowedServiceTiers.free],
				pro: [...tierAllowedServiceTiers.pro],
				admin: [...tierAllowedServiceTiers.admin]
			},
			modelLockUpgradeMessage,
			serviceTierLockUpgradeMessage
		} satisfies ModelCatalog;
		return catalog;
	}
});
