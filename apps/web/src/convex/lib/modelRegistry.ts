'use node';

import { createBedrockAnthropic } from '@ai-sdk/amazon-bedrock/anthropic';
import { createBedrockMantle } from '@ai-sdk/amazon-bedrock/mantle';
import { createAnthropic, type AnthropicProvider } from '@ai-sdk/anthropic';
import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import { createXai, type XaiProvider } from '@ai-sdk/xai';
import {
	getModelDefinition,
	type SupportedModelId,
	type SupportedReasoningEffort,
	type SupportedServiceTier
} from '@convex/lib/models';
import type { JSONValue, LanguageModel } from 'ai';
import { createFallback, defaultShouldRetryThisError } from 'ai-fallback';

type FallbackModels = NonNullable<Parameters<typeof createFallback>[0]['models']>;

type ProviderFetch = NonNullable<NonNullable<Parameters<typeof createAnthropic>[0]>['fetch']>;
type ProviderFetchInput = Parameters<ProviderFetch>[0];
type ProviderRequestOptions = {
	serviceTier?: 'auto' | 'priority' | 'standard_only';
	promptCacheKey?: string;
};

function providerPathname(input: ProviderFetchInput): string {
	return new URL(input instanceof Request ? input.url : input.toString()).pathname;
}

function supportsProviderRequestOptions(pathname: string): boolean {
	return (
		pathname.endsWith('/messages') ||
		pathname.endsWith('/responses') ||
		pathname.endsWith('/chat/completions')
	);
}

// The pinned Anthropic and xAI adapters do not expose their service-tier fields yet.
// The xAI adapter also does not expose the Responses API prompt_cache_key field.
export function createProviderFetch(
	options: ProviderRequestOptions,
	baseFetch: ProviderFetch = globalThis.fetch
): ProviderFetch {
	return (input, init) => {
		const pathname = providerPathname(input);
		if (!supportsProviderRequestOptions(pathname)) return baseFetch(input, init);
		if (typeof init?.body !== 'string') {
			throw new Error('Cannot apply provider request options without a JSON body.');
		}

		const body: unknown = JSON.parse(init.body);
		if (body === null || typeof body !== 'object' || Array.isArray(body)) {
			throw new Error('Cannot apply provider request options to a non-object JSON body.');
		}
		return baseFetch(input, {
			...init,
			body: JSON.stringify({
				...body,
				...(options.serviceTier !== undefined ? { service_tier: options.serviceTier } : {}),
				...(options.promptCacheKey !== undefined && pathname.endsWith('/responses')
					? { prompt_cache_key: options.promptCacheKey }
					: {})
			})
		});
	};
}

const openai: OpenAIProvider = createOpenAI({
	apiKey: process.env.OPENAI_API_KEY
});
const anthropic: AnthropicProvider = createAnthropic({
	apiKey: process.env.ANTHROPIC_API_KEY,
	fetch: createProviderFetch({ serviceTier: 'standard_only' })
});
const anthropicFast: AnthropicProvider = createAnthropic({
	apiKey: process.env.ANTHROPIC_API_KEY,
	fetch: createProviderFetch({ serviceTier: 'auto' })
});

export function hasBedrockCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.AWS_BEARER_TOKEN_BEDROCK?.trim()) return true;
	return Boolean(env.AWS_ACCESS_KEY_ID?.trim() && env.AWS_SECRET_ACCESS_KEY?.trim());
}

function shouldFailoverToBedrock(error: Error): boolean {
	const statusCode = (error as { statusCode?: unknown }).statusCode;
	// Auth/permission failures are configuration problems; do not silently bill Bedrock.
	if (statusCode === 401 || statusCode === 403) return false;
	return defaultShouldRetryThisError(error);
}

function withBedrockFallback(
	primary: LanguageModel,
	createFallbackModel: () => LanguageModel
): LanguageModel {
	if (!hasBedrockCredentials()) return primary;
	return createFallback({
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
	const region = process.env.AWS_REGION?.trim() || 'us-east-1';
	if (provider === 'anthropic') {
		return createBedrockAnthropic({ region })(`us.anthropic.${modelId}`);
	}
	// Mantle Responses expects the OpenAI-compatible path (/openai/v1), not the SDK default /v1.
	return createBedrockMantle({
		region,
		baseURL: `https://bedrock-mantle.${region}.api.aws/openai/v1`
	}).responses(`openai.${modelId}`);
}

export function resolveLanguageModel(
	modelId: SupportedModelId,
	serviceTier: SupportedServiceTier,
	promptCacheKey: string
): LanguageModel {
	const provider = getModelDefinition(modelId).provider;
	if (provider === 'anthropic') {
		const primary = serviceTier === 'fast' ? anthropicFast(modelId) : anthropic(modelId);
		return withBedrockFallback(primary, () => resolveBedrockFallbackModel('anthropic', modelId));
	}
	if (provider === 'xai') {
		const xai: XaiProvider = createXai({
			apiKey: process.env.XAI_API_KEY,
			fetch: createProviderFetch({
				...(serviceTier === 'fast' ? { serviceTier: 'priority' } : {}),
				promptCacheKey
			})
		});
		return xai(modelId);
	}
	return withBedrockFallback(openai(modelId), () => resolveBedrockFallbackModel('openai', modelId));
}

export function resolveProviderOptions(
	modelId: SupportedModelId,
	reasoningEffort: SupportedReasoningEffort | undefined,
	serviceTier: SupportedServiceTier,
	promptCacheKey: string
): Record<string, Record<string, JSONValue>> {
	const provider = getModelDefinition(modelId).provider;
	if (provider === 'anthropic') {
		return {
			anthropic: {
				...(reasoningEffort !== undefined ? { effort: reasoningEffort } : {}),
				cacheControl: { type: 'ephemeral' }
			}
		};
	}
	if (provider === 'xai') {
		return { xai: { ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) } };
	}
	return {
		openai: {
			...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
			serviceTier: serviceTier === 'fast' ? 'priority' : 'default',
			promptCacheKey,
			promptCacheOptions: { mode: 'implicit', ttl: '30m' }
		}
	};
}
