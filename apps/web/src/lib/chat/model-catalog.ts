import type { CatalogModel, ModelCatalog } from '$convex/lib/uiModelCatalog';
import type { CompletionProvider } from '$convex/lib/validators';
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
	tier: string,
	modelId: CatalogModelId
): boolean {
	// Tiers missing from the catalog allow every model.
	return (catalog.tierAllowedModels[tier] ?? catalog.models.map((model) => model.id)).includes(
		modelId
	);
}

export function resolveModelForTier(
	catalog: ModelCatalog,
	tier: string,
	modelId: CatalogModelId
): CatalogModelId {
	if (isModelAllowedForTier(catalog, tier, modelId)) return modelId;
	return catalog.tierAllowedModels[tier]?.[0] ?? catalog.defaultModelId;
}

export function fastModeAccessForModelAndTier(
	catalog: ModelCatalog,
	tier: string,
	model: CatalogModel
): FastModeAccess {
	if (!model.supportsFastMode) return 'unsupported';
	// Tiers missing from the catalog allow fast mode.
	return (catalog.tierAllowsFastMode[tier] ?? true) ? 'available' : 'locked';
}

export function showsReasoningControl(model: CatalogModel): boolean {
	return model.reasoningEfforts.length !== 1 || model.reasoningEfforts[0] !== 'none';
}

export function modelOptionsForTier(catalog: ModelCatalog, tier: string): ModelSelectorOption[] {
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

export function modelOptionsForCompletionProvider(
	catalog: ModelCatalog,
	tier: string,
	provider: CompletionProvider,
	chatGptModelIds: readonly string[] | null = null
): ModelSelectorOption[] {
	if (provider === 'spikonado') return modelOptionsForTier(catalog, tier);
	return catalog.models
		.filter(
			(model) =>
				model.provider === 'openai' &&
				(provider !== 'chatgpt' || chatGptModelIds?.includes(model.id))
		)
		.map((model) => ({ id: model.id, label: model.label, provider: model.provider }));
}

export function resolveModelForCompletionProvider(
	catalog: ModelCatalog,
	tier: string,
	provider: CompletionProvider,
	modelId: CatalogModelId,
	chatGptModelIds: readonly string[] | null = null
): CatalogModelId | undefined {
	const options = modelOptionsForCompletionProvider(catalog, tier, provider, chatGptModelIds);
	if (options.some((option) => option.id === modelId && !option.locked)) return modelId;
	return options.find((option) => !option.locked)?.id;
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
		tierAllowedModels: z
			.record(z.string(), z.array(z.string()))
			.refine((maps) => Object.keys(maps).length > 0, {
				message: 'Expected at least one tier in tierAllowedModels.'
			}),
		tierAllowedServiceTiers: z
			.record(z.string(), z.array(z.string()))
			.refine((maps) => Object.keys(maps).length > 0, {
				message: 'Expected at least one tier in tierAllowedServiceTiers.'
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
		tierAllowsFastMode: Object.fromEntries(
			Object.entries(sprocket.tierAllowedServiceTiers).map(([tier, serviceTiers]) => [
				tier,
				serviceTiers.includes('fast')
			])
		),
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
