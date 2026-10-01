import type { CatalogModel, ModelCatalog } from '@convex/lib/uiModelCatalog';
import type { CompletionProvider } from '@convex/lib/validators';
import {
	CATALOG_UNAVAILABLE_MESSAGE,
	GATEWAY_API_PREFIX,
	GATEWAY_PROTOCOL_VERSION
} from '@convex/lib/gatewayProtocol';
import { z } from 'zod';

export type { CatalogModel, ModelCatalog };

export type CatalogModelId = CatalogModel['id'];

export { CATALOG_UNAVAILABLE_MESSAGE };

export type ModelSelectorOption = {
	id: CatalogModelId;
	label: string;
	provider: string;
};

export function getCatalogModel(
	catalog: ModelCatalog,
	modelId: CatalogModelId
): CatalogModel | undefined {
	return catalog.models.find((model) => model.id === modelId);
}

export function showsReasoningControl(model: CatalogModel): boolean {
	return model.reasoningEfforts.length !== 1 || model.reasoningEfforts[0] !== 'none';
}

export function modelOptionsForCompletionProvider(
	catalog: ModelCatalog,
	provider: CompletionProvider,
	chatGptModelIds: readonly string[] | null = null
): ModelSelectorOption[] {
	if (provider === 'chatgpt') {
		return (chatGptModelIds ?? []).flatMap((id) => {
			const model = catalog.models.find((model) => model.id === id && model.provider === 'openai');

			return model ? [{ id, label: model.label, provider: model.provider }] : [];
		});
	}

	return catalog.models
		.filter((model) => provider === 'spikonado' || model.provider === 'openai')
		.map((model) => ({ id: model.id, label: model.label, provider: model.provider }));
}

export function resolveModelForCompletionProvider(
	catalog: ModelCatalog,
	provider: CompletionProvider,
	modelId: CatalogModelId,
	chatGptModelIds: readonly string[] | null = null
): CatalogModelId | undefined {
	const options = modelOptionsForCompletionProvider(catalog, provider, chatGptModelIds);

	if (options.some((option) => option.id === modelId)) return modelId;

	return options.some((option) => option.id === catalog.defaultModelId)
		? catalog.defaultModelId
		: options[0]?.id;
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
		models: z.array(gatewayModelSchema).min(1)
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
		}))
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
