import type { SubscriptionTier } from '$convex/lib/tiers';
import type { CatalogModel, ModelCatalog } from '$convex/lib/uiModelCatalog';
import {
	CATALOG_UNAVAILABLE_MESSAGE,
	GATEWAY_API_PREFIX,
	GATEWAY_PROTOCOL_VERSION
} from '$convex/lib/gatewayProtocol';
import { z } from 'zod';

export type { CatalogModel, ModelCatalog };
export type CatalogModelId = CatalogModel['id'];
export type FastModeAccess = 'unsupported' | 'locked' | 'available';
export { CATALOG_UNAVAILABLE_MESSAGE };

export type ModelSelectorOption = {
	id: CatalogModelId;
	label: string;
	provider: string;
	locked?: boolean;
	lockTooltip?: string;
};

export function getCatalogModel(
	catalog: ModelCatalog,
	modelId: CatalogModelId
): CatalogModel | undefined {
	return catalog.models.find((model) => model.id === modelId);
}

export function isModelAllowedForTier(
	catalog: ModelCatalog,
	tier: SubscriptionTier,
	modelId: CatalogModelId
): boolean {
	return (catalog.tierAllowedModels[tier] ?? []).includes(modelId);
}

export function resolveModelForTier(
	catalog: ModelCatalog,
	tier: SubscriptionTier,
	modelId: CatalogModelId
): CatalogModelId {
	if (isModelAllowedForTier(catalog, tier, modelId)) return modelId;
	return catalog.tierAllowedModels[tier]?.[0] ?? catalog.defaultModelId;
}

export function fastModeAccessForModelAndTier(
	catalog: ModelCatalog,
	tier: SubscriptionTier,
	model: CatalogModel
): FastModeAccess {
	if (!model.supportsFastMode) return 'unsupported';
	return catalog.tierAllowsFastMode[tier] ? 'available' : 'locked';
}

export function modelOptionsForTier(
	catalog: ModelCatalog,
	tier: SubscriptionTier
): ModelSelectorOption[] {
	const unlocked: ModelSelectorOption[] = [];
	const locked: ModelSelectorOption[] = [];
	for (const model of catalog.models) {
		const option = { id: model.id, label: model.label, provider: model.provider };
		if (isModelAllowedForTier(catalog, tier, model.id)) {
			unlocked.push(option);
		} else {
			locked.push({
				...option,
				locked: true,
				lockTooltip: catalog.modelLockUpgradeMessage
			});
		}
	}
	return [...unlocked, ...locked];
}

/** Prefer a known label; fall back to the raw id so newer catalog values still render. */
export function reasoningEffortLabel(effort: string): string {
	switch (effort) {
		case 'none':
			return 'None';
		case 'low':
			return 'Low';
		case 'medium':
			return 'Medium';
		case 'high':
			return 'High';
		case 'xhigh':
			return 'Extra High';
		case 'max':
			return 'Max';
		default:
			return effort;
	}
}

const gatewayModelSchema = z.looseObject({
	id: z.string().min(1),
	label: z.string().min(1),
	provider: z.string().min(1),
	supportsImages: z.boolean(),
	contextWindowTokens: z.int(),
	autoCompactTokenLimit: z.int(),
	reasoningEfforts: z.array(z.string()).min(1),
	defaultReasoningEffort: z.string().min(1),
	serviceTiers: z.array(z.string()).min(1),
	usagePolicy: z.literal('unlimited').optional()
});

const gatewayModelsResponseSchema = z.object({
	sprocket: z.object({
		protocolVersion: z.int(),
		catalogVersion: z.string().min(1),
		defaultModelId: z.string().min(1),
		defaultReasoningEffort: z.string().min(1),
		defaultServiceTier: z.string().min(1),
		models: z.array(gatewayModelSchema).min(1),
		tierAllowedModels: z.object({
			free: z.array(z.string()),
			pro: z.array(z.string()),
			admin: z.array(z.string())
		}),
		tierAllowedServiceTiers: z.object({
			free: z.array(z.string()),
			pro: z.array(z.string()),
			admin: z.array(z.string())
		}),
		modelLockUpgradeMessage: z.string().min(1),
		serviceTierLockUpgradeMessage: z.string().min(1)
	})
});

function catalogFromGatewayPayload(
	payload: z.infer<typeof gatewayModelsResponseSchema>
): ModelCatalog {
	const sprocket = payload.sprocket;
	if (sprocket.protocolVersion !== GATEWAY_PROTOCOL_VERSION) {
		throw new Error(
			`${CATALOG_UNAVAILABLE_MESSAGE} Unsupported protocol version ${sprocket.protocolVersion}.`
		);
	}
	return {
		protocolVersion: sprocket.protocolVersion,
		catalogVersion: sprocket.catalogVersion,
		defaultModelId: sprocket.defaultModelId,
		defaultReasoningEffort: sprocket.defaultReasoningEffort,
		models: sprocket.models.map((model) => ({
			id: model.id,
			label: model.label,
			provider: model.provider,
			supportsImages: model.supportsImages,
			contextWindowTokens: model.contextWindowTokens,
			autoHandoffTokenLimit: model.autoCompactTokenLimit,
			reasoningEfforts: model.reasoningEfforts,
			defaultReasoningEffort: model.defaultReasoningEffort,
			supportsFastMode: model.serviceTiers.includes('fast'),
			usagePolicy: model.usagePolicy
		})),
		tierAllowedModels: sprocket.tierAllowedModels,
		tierAllowsFastMode: {
			free: sprocket.tierAllowedServiceTiers.free.includes('fast'),
			pro: sprocket.tierAllowedServiceTiers.pro.includes('fast'),
			admin: sprocket.tierAllowedServiceTiers.admin.includes('fast')
		},
		modelLockUpgradeMessage: sprocket.modelLockUpgradeMessage,
		fastModeLockUpgradeMessage: sprocket.serviceTierLockUpgradeMessage
	};
}

/** Live catalog from `GET {origin}/api/v1/models`. */
export async function fetchGatewayModelCatalog(gatewayOrigin: string): Promise<ModelCatalog> {
	const origin = gatewayOrigin.replace(/\/+$/, '');
	if (!origin) {
		throw new Error(CATALOG_UNAVAILABLE_MESSAGE);
	}
	const response = await fetch(`${origin}${GATEWAY_API_PREFIX}/v1/models`, {
		headers: { accept: 'application/json' }
	});
	if (!response.ok) {
		throw new Error(CATALOG_UNAVAILABLE_MESSAGE);
	}
	const parsed = gatewayModelsResponseSchema.safeParse(await response.json());
	if (!parsed.success) {
		throw new Error(CATALOG_UNAVAILABLE_MESSAGE);
	}
	return catalogFromGatewayPayload(parsed.data);
}
