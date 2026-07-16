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
import type { LanguageModel } from 'ai';

type ProviderFetch = NonNullable<NonNullable<Parameters<typeof createAnthropic>[0]>['fetch']>;

function supportsServiceTier(input: Parameters<ProviderFetch>[0]): boolean {
	const url = input instanceof Request ? input.url : input.toString();
	const pathname = new URL(url).pathname;
	return (
		pathname.endsWith('/messages') ||
		pathname.endsWith('/responses') ||
		pathname.endsWith('/chat/completions')
	);
}

// The pinned Anthropic and xAI adapters do not expose their service-tier fields yet.
export function createServiceTierFetch(
	serviceTier: 'auto' | 'priority' | 'standard_only',
	baseFetch: ProviderFetch = globalThis.fetch
): ProviderFetch {
	return (input, init) => {
		if (!supportsServiceTier(input)) return baseFetch(input, init);
		if (typeof init?.body !== 'string') {
			throw new Error('Cannot apply a provider service tier to a request without a JSON body.');
		}

		const body: unknown = JSON.parse(init.body);
		if (body === null || typeof body !== 'object' || Array.isArray(body)) {
			throw new Error('Cannot apply a provider service tier to a non-object JSON body.');
		}

		return baseFetch(input, {
			...init,
			body: JSON.stringify({ ...body, service_tier: serviceTier })
		});
	};
}

const openai: OpenAIProvider = createOpenAI({
	apiKey: process.env.OPENAI_API_KEY
});
const anthropic: AnthropicProvider = createAnthropic({
	apiKey: process.env.ANTHROPIC_API_KEY,
	fetch: createServiceTierFetch('standard_only')
});
const anthropicFast: AnthropicProvider = createAnthropic({
	apiKey: process.env.ANTHROPIC_API_KEY,
	fetch: createServiceTierFetch('auto')
});
const xai: XaiProvider = createXai({
	apiKey: process.env.XAI_API_KEY
});
const xaiPriority: XaiProvider = createXai({
	apiKey: process.env.XAI_API_KEY,
	fetch: createServiceTierFetch('priority')
});

export function resolveLanguageModel(
	modelId: SupportedModelId,
	serviceTier: SupportedServiceTier
): LanguageModel {
	const provider = getModelDefinition(modelId).provider;
	if (provider === 'anthropic') {
		return serviceTier === 'fast' ? anthropicFast(modelId) : anthropic(modelId);
	}
	if (provider === 'xai') return serviceTier === 'fast' ? xaiPriority(modelId) : xai(modelId);
	return openai(modelId);
}

export function resolveProviderOptions(
	modelId: SupportedModelId,
	reasoningEffort: SupportedReasoningEffort | undefined,
	serviceTier: SupportedServiceTier
): Record<string, Record<string, string>> {
	const provider = getModelDefinition(modelId).provider;
	if (provider === 'anthropic') {
		return { anthropic: { ...(reasoningEffort !== undefined ? { effort: reasoningEffort } : {}) } };
	}
	if (provider === 'xai') {
		return { xai: { ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) } };
	}
	return {
		openai: {
			...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
			serviceTier: serviceTier === 'fast' ? 'priority' : 'default'
		}
	};
}
