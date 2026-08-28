import { v, type Infer } from 'convex/values';
import { z } from 'zod';
import { type JsonValue } from '@convex/lib/json';
import { CATALOG_UNAVAILABLE_MESSAGE, GATEWAY_PROTOCOL_VERSION } from '@convex/lib/gatewayProtocol';
import {
	reasoningEffortIds,
	serviceTierIds,
	type SupportedReasoningEffort,
	type SupportedServiceTier
} from '@convex/lib/models';
import { type SubscriptionTier } from '@convex/lib/tiers';
import { vReasoningEffort, vServiceTier } from '@convex/lib/validators';

const vGatewayUiCatalogModel = v.object({
	id: v.string(),
	label: v.string(),
	provider: v.string(),
	supportsImages: v.boolean(),
	contextWindowTokens: v.number(),
	autoCompactTokenLimit: v.number(),
	reasoningEfforts: v.array(vReasoningEffort),
	defaultReasoningEffort: vReasoningEffort,
	serviceTiers: v.array(vServiceTier),
	usagePolicy: v.optional(v.literal('unlimited'))
});

export const vGatewayUiCatalog = v.object({
	protocolVersion: v.number(),
	catalogVersion: v.string(),
	defaultModelId: v.string(),
	defaultReasoningEffort: vReasoningEffort,
	defaultServiceTier: vServiceTier,
	models: v.array(vGatewayUiCatalogModel),
	tierAllowedModels: v.object({
		free: v.array(v.string()),
		pro: v.array(v.string()),
		admin: v.array(v.string())
	}),
	tierAllowedServiceTiers: v.object({
		free: v.array(vServiceTier),
		pro: v.array(vServiceTier),
		admin: v.array(vServiceTier)
	}),
	modelLockUpgradeMessage: v.string(),
	serviceTierLockUpgradeMessage: v.string()
});

export type GatewayCatalogModel = {
	id: string;
	label: string;
	provider: string;
	supportsImages: boolean;
	contextWindowTokens: number;
	autoCompactTokenLimit: number;
	reasoningEfforts: SupportedReasoningEffort[];
	defaultReasoningEffort: SupportedReasoningEffort;
	serviceTiers: SupportedServiceTier[];
	usagePolicy?: 'unlimited';
};

export type GatewayCatalog = {
	protocolVersion: number;
	catalogVersion: string;
	defaultModelId: string;
	defaultReasoningEffort: SupportedReasoningEffort;
	defaultServiceTier: SupportedServiceTier;
	models: GatewayCatalogModel[];
	tierAllowedModels: Record<SubscriptionTier, string[]>;
	tierAllowedServiceTiers: Record<SubscriptionTier, SupportedServiceTier[]>;
	modelLockUpgradeMessage: string;
	serviceTierLockUpgradeMessage: string;
};

const gatewayReasoningEffortSchema = z.enum(reasoningEffortIds);
const gatewayServiceTierSchema = z.enum(serviceTierIds);

const gatewayUsageWeightsSchema = z.object({
	input: z.number().finite(),
	cacheRead: z.number().finite(),
	cacheWrite: z.number().finite(),
	output: z.number().finite(),
	fastMultiplier: z.number().finite()
});

const gatewayCatalogModelSchema = z.object({
	id: z.string().min(1),
	label: z.string().min(1),
	provider: z.string().min(1),
	inferenceProvider: z.string().min(1).optional(),
	supportsImages: z.boolean(),
	contextWindowTokens: z.number().finite(),
	autoCompactTokenLimit: z.number().finite(),
	reasoningEfforts: z.array(gatewayReasoningEffortSchema).min(1),
	defaultReasoningEffort: gatewayReasoningEffortSchema,
	serviceTiers: z.array(gatewayServiceTierSchema).min(1),
	usagePolicy: z.literal('unlimited').optional(),
	// Present on the catalog contract. Convex validates then drops rates;
	// charging uses gateway-computed units only.
	usageWeights: gatewayUsageWeightsSchema
});

const gatewayTierModelMapSchema = z.object({
	free: z.array(z.string()),
	pro: z.array(z.string()),
	admin: z.array(z.string())
});

const gatewayTierServiceMapSchema = z.object({
	free: z.array(gatewayServiceTierSchema),
	pro: z.array(gatewayServiceTierSchema),
	admin: z.array(gatewayServiceTierSchema)
});

const gatewayModelsResponseSchema = z.object({
	sprocket: z.object({
		protocolVersion: z.number().finite(),
		catalogVersion: z.string().min(1),
		defaultModelId: z.string().min(1),
		defaultReasoningEffort: gatewayReasoningEffortSchema,
		defaultServiceTier: gatewayServiceTierSchema,
		models: z.array(gatewayCatalogModelSchema),
		tierAllowedModels: gatewayTierModelMapSchema,
		tierAllowedServiceTiers: gatewayTierServiceMapSchema,
		modelLockUpgradeMessage: z.string().min(1),
		serviceTierLockUpgradeMessage: z.string().min(1)
	})
});

export function parseGatewayModelsResponse(value: JsonValue): GatewayCatalog {
	const parsed = gatewayModelsResponseSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error(CATALOG_UNAVAILABLE_MESSAGE);
	}
	const sprocket = parsed.data.sprocket;
	if (sprocket.protocolVersion !== GATEWAY_PROTOCOL_VERSION) {
		throw new Error(
			`${CATALOG_UNAVAILABLE_MESSAGE} Unsupported protocol version ${sprocket.protocolVersion}.`
		);
	}
	if (sprocket.models.length === 0) {
		throw new Error(`${CATALOG_UNAVAILABLE_MESSAGE} Catalog has no models.`);
	}
	for (const model of sprocket.models) {
		if (!model.reasoningEfforts.includes(model.defaultReasoningEffort)) {
			throw new Error(`${CATALOG_UNAVAILABLE_MESSAGE} Invalid model reasoning efforts.`);
		}
	}
	const catalog: GatewayCatalog = {
		protocolVersion: sprocket.protocolVersion,
		catalogVersion: sprocket.catalogVersion,
		defaultModelId: sprocket.defaultModelId,
		defaultReasoningEffort: sprocket.defaultReasoningEffort,
		defaultServiceTier: sprocket.defaultServiceTier,
		models: sprocket.models.map((model) => ({
			id: model.id,
			label: model.label,
			provider: model.provider,
			supportsImages: model.supportsImages,
			contextWindowTokens: model.contextWindowTokens,
			autoCompactTokenLimit: model.autoCompactTokenLimit,
			reasoningEfforts: [...model.reasoningEfforts],
			defaultReasoningEffort: model.defaultReasoningEffort,
			serviceTiers: [...model.serviceTiers],
			usagePolicy: model.usagePolicy
		})),
		tierAllowedModels: sprocket.tierAllowedModels,
		tierAllowedServiceTiers: sprocket.tierAllowedServiceTiers,
		modelLockUpgradeMessage: sprocket.modelLockUpgradeMessage,
		serviceTierLockUpgradeMessage: sprocket.serviceTierLockUpgradeMessage
	};
	if (!catalog.models.some((model) => model.id === catalog.defaultModelId)) {
		throw new Error(`${CATALOG_UNAVAILABLE_MESSAGE} Default model is missing.`);
	}
	return catalog;
}

export function findGatewayCatalogModel(
	catalog: GatewayCatalog,
	modelId: string
): GatewayCatalogModel | undefined {
	return catalog.models.find((model) => model.id === modelId);
}

export function toGatewayUiCatalog(catalog: GatewayCatalog): Infer<typeof vGatewayUiCatalog> {
	return {
		protocolVersion: catalog.protocolVersion,
		catalogVersion: catalog.catalogVersion,
		defaultModelId: catalog.defaultModelId,
		defaultReasoningEffort: catalog.defaultReasoningEffort,
		defaultServiceTier: catalog.defaultServiceTier,
		models: catalog.models.map((model) => ({
			id: model.id,
			label: model.label,
			provider: model.provider,
			supportsImages: model.supportsImages,
			contextWindowTokens: model.contextWindowTokens,
			autoCompactTokenLimit: model.autoCompactTokenLimit,
			reasoningEfforts: model.reasoningEfforts,
			defaultReasoningEffort: model.defaultReasoningEffort,
			serviceTiers: model.serviceTiers,
			usagePolicy: model.usagePolicy
		})),
		tierAllowedModels: catalog.tierAllowedModels,
		tierAllowedServiceTiers: catalog.tierAllowedServiceTiers,
		modelLockUpgradeMessage: catalog.modelLockUpgradeMessage,
		serviceTierLockUpgradeMessage: catalog.serviceTierLockUpgradeMessage
	};
}

export function assertGatewayModelConfiguration(
	catalog: GatewayCatalog,
	args: {
		modelId: string;
		reasoningEffort?: string;
		serviceTier: string;
		hasImages?: boolean;
	}
): GatewayCatalogModel {
	const model = findGatewayCatalogModel(catalog, args.modelId);
	if (!model) throw new Error(`Unsupported model: ${args.modelId}`);
	if (
		args.reasoningEffort !== undefined &&
		!model.reasoningEfforts.some((effort) => effort === args.reasoningEffort)
	) {
		throw new Error(`${model.label} does not support ${args.reasoningEffort} reasoning.`);
	}
	if (!model.serviceTiers.some((tier) => tier === args.serviceTier)) {
		throw new Error(`${model.label} does not support the ${args.serviceTier} service tier.`);
	}
	if (args.hasImages && !model.supportsImages) {
		throw new Error(`${model.label} does not support image attachments.`);
	}
	return model;
}

export function assertGatewayEntitlements(
	catalog: GatewayCatalog,
	tier: SubscriptionTier,
	args: { modelId: string; serviceTier: string }
): void {
	if (!(catalog.tierAllowedModels[tier] ?? []).includes(args.modelId)) {
		const model = findGatewayCatalogModel(catalog, args.modelId);
		const label = model?.label ?? args.modelId;
		throw new Error(
			`${label} is not available on the ${tier} plan. Upgrade to a higher tier to unlock this model.`
		);
	}
	if (
		!(catalog.tierAllowedServiceTiers[tier] ?? []).some((allowed) => allowed === args.serviceTier)
	) {
		throw new Error(
			`The ${args.serviceTier} service tier is not available on the ${tier} plan. Upgrade to a higher tier to unlock it.`
		);
	}
}
