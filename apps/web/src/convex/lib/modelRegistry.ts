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

const openai: OpenAIProvider = createOpenAI({
	apiKey: process.env.OPENAI_API_KEY
});
const anthropic: AnthropicProvider = createAnthropic({
	apiKey: process.env.ANTHROPIC_API_KEY
});
const xai: XaiProvider = createXai({
	apiKey: process.env.XAI_API_KEY
});

export function resolveLanguageModel(modelId: SupportedModelId): LanguageModel {
	const provider = getModelDefinition(modelId).provider;
	if (provider === 'anthropic') return anthropic(modelId);
	if (provider === 'xai') return xai(modelId);
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
