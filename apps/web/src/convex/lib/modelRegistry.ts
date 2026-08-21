'use node';

import { createBedrockAnthropic } from '@ai-sdk/amazon-bedrock/anthropic';
import { createBedrockMantle } from '@ai-sdk/amazon-bedrock/mantle';
import { createAnthropic, type AnthropicProvider } from '@ai-sdk/anthropic';
import { createFireworks, type FireworksProvider } from '@ai-sdk/fireworks';
import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
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
				...(options.serviceTier !== undefined ? { service_tier: options.serviceTier } : {})
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
const fireworks: FireworksProvider = createFireworks({
	apiKey: process.env.FIREWORKS_API_KEY
});
const zai = createOpenAICompatible({
	name: 'zai',
	baseURL: 'https://api.z.ai/api/paas/v4',
	apiKey: process.env.ZAI_API_KEY,
	// GLM 5.3 rejects thinking.type=disabled; thinking is always on.
	transformRequestBody: (args) => ({ ...args, thinking: { type: 'enabled' } })
});

export function hasBedrockCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.AWS_BEARER_TOKEN_BEDROCK?.trim()) return true;
	return Boolean(env.AWS_ACCESS_KEY_ID?.trim() && env.AWS_SECRET_ACCESS_KEY?.trim());
}

function statusCodeFromError(error: unknown): number | undefined {
	if (!error || typeof error !== 'object') return undefined;
	const value = error as Record<string, unknown>;
	if (typeof value.statusCode === 'number') return value.statusCode;
	if (typeof value.status === 'number') return value.status;
	const response = value.response;
	if (response && typeof response === 'object') {
		const status = (response as Record<string, unknown>).status;
		if (typeof status === 'number') return status;
	}
	return statusCodeFromError(value.cause);
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

function fireworksModelPath(modelId: SupportedModelId): string {
	switch (modelId) {
		case 'kimi-k3':
			return 'accounts/fireworks/models/kimi-k3';
		case 'deepseek-v4-pro':
			return 'accounts/fireworks/models/deepseek-v4-pro';
		case 'deepseek-v4-flash':
			return 'accounts/fireworks/models/deepseek-v4-flash-0731';
		default:
			throw new Error(`Unsupported Fireworks model: ${modelId}`);
	}
}

export function resolveLanguageModel(
	modelId: SupportedModelId,
	serviceTier: SupportedServiceTier
): LanguageModel {
	const provider = getModelDefinition(modelId).provider;
	if (provider === 'anthropic') {
		const primary = serviceTier === 'fast' ? anthropicFast(modelId) : anthropic(modelId);
		// Bedrock has no priority/fast routes; fail over only on standard.
		if (serviceTier === 'fast') return primary;
		return withBedrockFallback(primary, () => resolveBedrockFallbackModel('anthropic', modelId));
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
	if (provider === 'zai') {
		return {
			zai: {
				...(reasoningEffort !== undefined ? { reasoningEffort } : {})
			}
		};
	}
	if (provider === 'kimi' || provider === 'deepseek') {
		return {
			fireworks: {
				...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
				promptCacheKey,
				reasoningHistory: 'interleaved'
			}
		};
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
