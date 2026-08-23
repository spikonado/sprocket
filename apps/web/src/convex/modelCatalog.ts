import {
	defaultModelId,
	defaultReasoningEffort,
	defaultServiceTier,
	modelDefinitions,
	type ModelDefinition
} from '@convex/lib/models';
import {
	modelLockUpgradeMessage,
	serviceTierLockUpgradeMessage,
	tierAllowedModels,
	tierAllowedServiceTiers
} from '@convex/lib/tiers';
import { v } from 'convex/values';
import { vModelCatalog } from '@convex/lib/docs';
import type { CatalogModelWithUsagePolicy } from '@convex/lib/uiModelCatalog';
import { query } from './_generated/server';

/**
 * UI-facing catalog so clients pick up new models from Convex deploys without a client update.
 * Intentionally unauthenticated: the catalog is not secret (model ids/labels/limits only).
 * Entitlements are enforced server-side on send/usage paths.
 */
export const get = query({
	args: { includeUsagePolicy: v.optional(v.boolean()) },
	returns: vModelCatalog,
	handler: async (_ctx, args) => {
		const catalog = {
			defaultModelId,
			defaultReasoningEffort,
			defaultServiceTier,
			// Omit server-only routing and usage fields from the UI catalog.
			models: modelDefinitions.map((definition: ModelDefinition) => {
				const { inferenceProvider, usagePolicy, usageWeights, ...model } = definition;
				void inferenceProvider;
				void usageWeights;
				return {
					...model,
					reasoningEfforts: [...model.reasoningEfforts],
					serviceTiers: [...model.serviceTiers],
					...(args.includeUsagePolicy && usagePolicy ? { usagePolicy } : {})
				} satisfies CatalogModelWithUsagePolicy;
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
		};
		return catalog;
	}
});
