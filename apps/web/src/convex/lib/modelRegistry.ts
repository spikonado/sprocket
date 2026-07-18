'use node';

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

export function resolveLanguageModel(
	modelId: SupportedModelId,
	serviceTier: SupportedServiceTier,
	promptCacheKey: string
): LanguageModel {
	const provider = getModelDefinition(modelId).provider;
	if (provider === 'anthropic') {
		return serviceTier === 'fast' ? anthropicFast(modelId) : anthropic(modelId);
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
	return openai(modelId);
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
