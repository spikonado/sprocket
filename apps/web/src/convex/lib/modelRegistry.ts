'use node';

import { createBedrockAnthropic } from '@ai-sdk/amazon-bedrock/anthropic';
import { createBedrockMantle } from '@ai-sdk/amazon-bedrock/mantle';
import { createAnthropic, type AnthropicProvider } from '@ai-sdk/anthropic';
import { createFireworks, type FireworksProvider } from '@ai-sdk/fireworks';
import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { env } from '@convex/_generated/server';
import {
	getModelDefinition,
	type SupportedModelId,
	type SupportedReasoningEffort,
	type SupportedServiceTier
} from '@convex/lib/models';
import { isJsonNumber, isJsonObject, isJsonValue } from '@convex/lib/json';
import type { LanguageModel } from 'ai';
import { createFallback, defaultShouldRetryThisError } from 'ai-fallback';
import { z } from 'zod';

type FallbackModels = NonNullable<Parameters<typeof createFallback>[0]['models']>;

type ProviderFetch = NonNullable<NonNullable<Parameters<typeof createAnthropic>[0]>['fetch']>;
type ProviderFetchInput = Parameters<ProviderFetch>[0];
type ProviderRequestOptions = {
	serviceTier?: 'auto' | 'standard_only';
};

function providerPathname(input: ProviderFetchInput): string {
	return new URL(input instanceof Request ? input.url : input.toString()).pathname;
}

// The pinned Anthropic adapter does not expose its service-tier field yet.
export function createProviderFetch(
	options: ProviderRequestOptions,
	baseFetch: ProviderFetch = globalThis.fetch
): ProviderFetch {
	return (input, init) => {
		if (!providerPathname(input).endsWith('/messages')) return baseFetch(input, init);
		const bodyText = z.string().safeParse(init?.body);
		if (!bodyText.success) {
			throw new Error('Cannot apply provider request options without a JSON body.');
		}

		const body = JSON.parse(bodyText.data);
		if (!isJsonObject(body)) {
			throw new Error('Cannot apply provider request options to a non-object JSON body.');
		}
		if (options.serviceTier !== undefined) {
			body.service_tier = options.serviceTier;
		}
		return baseFetch(input, {
			...init,
			body: JSON.stringify(body)
		});
	};
}

const openai: OpenAIProvider = createOpenAI({
	apiKey: env.OPENAI_API_KEY
});
const anthropic: AnthropicProvider = createAnthropic({
	apiKey: env.ANTHROPIC_API_KEY,
	fetch: createProviderFetch({ serviceTier: 'standard_only' })
});
const anthropicFast: AnthropicProvider = createAnthropic({
	apiKey: env.ANTHROPIC_API_KEY,
	fetch: createProviderFetch({ serviceTier: 'auto' })
});
const fireworks: FireworksProvider = createFireworks({
	apiKey: env.FIREWORKS_API_KEY
});
const zai = createOpenAICompatible({
	name: 'zai',
	baseURL: 'https://api.z.ai/api/paas/v4',
	apiKey: env.ZAI_API_KEY,
	// GLM 5.3 rejects thinking.type=disabled; thinking is always on.
	transformRequestBody: (args) => ({ ...args, thinking: { type: 'enabled' } })
});
const openrouter = createOpenAICompatible({
	name: 'openrouter',
	baseURL: 'https://openrouter.ai/api/v1',
	apiKey: env.OPENROUTER_API_KEY,
	includeUsage: true
});

type BedrockCredentialEnv = {
	AWS_BEARER_TOKEN_BEDROCK?: string;
	AWS_ACCESS_KEY_ID?: string;
	AWS_SECRET_ACCESS_KEY?: string;
};

export function hasBedrockCredentials(source: BedrockCredentialEnv = env): boolean {
	if (source.AWS_BEARER_TOKEN_BEDROCK?.trim()) return true;
	return Boolean(source.AWS_ACCESS_KEY_ID?.trim() && source.AWS_SECRET_ACCESS_KEY?.trim());
}

const errorStatusSchema = z
	.object({
		statusCode: z.unknown().optional(),
		status: z.unknown().optional(),
		response: z.unknown().optional(),
		cause: z.any().optional()
	})
	.loose();

type ErrorStatusCarrier = z.infer<typeof errorStatusSchema>;

function isErrorStatusCarrier(value: ErrorStatusCarrier['cause']): value is ErrorStatusCarrier {
	return errorStatusSchema.safeParse(value).success;
}

function statusCodeFromError(error: Error): number | undefined {
	const seen: object[] = [];
	let current: object | undefined = error;
	while (current !== undefined) {
		if (seen.includes(current)) return undefined;
		seen.push(current);
		const parsed = errorStatusSchema.safeParse(current);
		if (!parsed.success) break;
		if (isJsonValue(parsed.data.statusCode) && isJsonNumber(parsed.data.statusCode)) {
			return parsed.data.statusCode;
		}
		if (isJsonValue(parsed.data.status) && isJsonNumber(parsed.data.status)) {
			return parsed.data.status;
		}
		if (
			isJsonValue(parsed.data.response) &&
			isJsonObject(parsed.data.response) &&
			isJsonNumber(parsed.data.response.status)
		) {
			return parsed.data.response.status;
		}
		current = isErrorStatusCarrier(parsed.data.cause) ? parsed.data.cause : undefined;
	}
	return undefined;
}

function shouldFailoverToBedrock(error: Error): boolean {
	const statusCode = statusCodeFromError(error);
	// Auth/permission failures are configuration problems; do not silently bill Bedrock.
	if (statusCode === 401 || statusCode === 403) return false;
	const message = error.message.toLowerCase();
	if (
		message.includes('wrong-key') ||
		message.includes('invalid api key') ||
		message.includes('incorrect api key') ||
		message.includes('unauthorized') ||
		message.includes('authentication')
	) {
		return false;
	}
	return defaultShouldRetryThisError(error);
}

function withBedrockFallback(
	primary: LanguageModel,
	createFallbackModel: () => LanguageModel
): LanguageModel {
	if (!hasBedrockCredentials()) return primary;
	return createFallback({
		// SAFETY: both entries are LanguageModel instances createFallback's models tuple accepts.
		models: [primary, createFallbackModel()] as FallbackModels,
		// Never splice a restarted Bedrock generation into an already-persisted stream.
		retryAfterOutput: false,
		shouldRetryThisError: shouldFailoverToBedrock,
		onError: (error, failedModelId) => {
			console.warn(`Model provider ${failedModelId} failed during completion.`, error);
		}
	});
}

function resolveBedrockFallbackModel(
	provider: 'openai' | 'anthropic',
	modelId: SupportedModelId
): LanguageModel {
	const region = env.AWS_REGION?.trim() || 'us-east-1';
	if (provider === 'anthropic') {
		return createBedrockAnthropic({ region })(`us.anthropic.${modelId}`);
	}
	// Mantle Responses expects the OpenAI-compatible path (/openai/v1), not the SDK default /v1.
	return createBedrockMantle({
		region,
		baseURL: `https://bedrock-mantle.${region}.api.aws/openai/v1`
	}).responses(`openai.${modelId}`);
}

function fireworksModelPath(modelId: SupportedModelId): string {
	const provider = getModelDefinition(modelId).provider;
	if (provider !== 'kimi' && provider !== 'deepseek') {
		throw new Error(`Unsupported Fireworks model: ${modelId}`);
	}
	return `accounts/fireworks/models/${modelId}`;
}

export function resolveLanguageModel(
	modelId: SupportedModelId,
	serviceTier: SupportedServiceTier
): LanguageModel {
	const model = getModelDefinition(modelId);
	const provider = model.inferenceProvider ?? model.provider;
	if (provider === 'anthropic') {
		const primary = serviceTier === 'fast' ? anthropicFast(modelId) : anthropic(modelId);
		// Bedrock has no priority/fast routes; fail over only on standard.
		if (serviceTier === 'fast') return primary;
		return withBedrockFallback(primary, () => resolveBedrockFallbackModel('anthropic', modelId));
	}
	if (provider === 'openrouter') {
		return openrouter.chatModel(modelId);
	}
	if (provider === 'zai') {
		return zai.chatModel(modelId);
	}
	if (provider === 'kimi' || provider === 'deepseek') {
		return fireworks(fireworksModelPath(modelId));
	}
	const openaiPrimary = openai(modelId);
	if (serviceTier === 'fast') return openaiPrimary;
	return withBedrockFallback(openaiPrimary, () => resolveBedrockFallbackModel('openai', modelId));
}

type ProviderOptions = {
	anthropic?: {
		effort?: SupportedReasoningEffort;
		cacheControl: { type: 'ephemeral' };
	};
	openrouter?: { reasoningEffort?: SupportedReasoningEffort };
	zai?: { reasoningEffort?: SupportedReasoningEffort };
	fireworks?: {
		reasoningEffort?: SupportedReasoningEffort;
		promptCacheKey: string;
		reasoningHistory: 'interleaved';
	};
	openai?: {
		reasoningEffort?: SupportedReasoningEffort;
		serviceTier: 'priority' | 'default';
		promptCacheKey: string;
		promptCacheOptions: { mode: 'implicit'; ttl: '30m' };
	};
};

export function resolveProviderOptions(
	modelId: SupportedModelId,
	reasoningEffort: SupportedReasoningEffort | undefined,
	serviceTier: SupportedServiceTier,
	promptCacheKey: string
): ProviderOptions {
	const model = getModelDefinition(modelId);
	const provider = model.inferenceProvider ?? model.provider;
	if (provider === 'anthropic') {
		const anthropic: NonNullable<ProviderOptions['anthropic']> = {
			cacheControl: { type: 'ephemeral' }
		};
		if (reasoningEffort !== undefined) anthropic.effort = reasoningEffort;
		return { anthropic };
	}
	if (provider === 'openrouter' || provider === 'zai') {
		const options: NonNullable<ProviderOptions['openrouter']> = {};
		if (reasoningEffort !== undefined) options.reasoningEffort = reasoningEffort;
		return { [provider]: options };
	}
	if (provider === 'kimi' || provider === 'deepseek') {
		const fireworks: NonNullable<ProviderOptions['fireworks']> = {
			promptCacheKey,
			reasoningHistory: 'interleaved'
		};
		if (reasoningEffort !== undefined) fireworks.reasoningEffort = reasoningEffort;
		return { fireworks };
	}
	const openai: NonNullable<ProviderOptions['openai']> = {
		serviceTier: serviceTier === 'fast' ? 'priority' : 'default',
		promptCacheKey,
		promptCacheOptions: { mode: 'implicit', ttl: '30m' }
	};
	if (reasoningEffort !== undefined) openai.reasoningEffort = reasoningEffort;
	return { openai };
}
