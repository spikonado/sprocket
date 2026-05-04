'use node';

import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import { type SupportedModelId, type SupportedReasoningEffort } from '@web-lib/models';

const openai: OpenAIProvider = createOpenAI({
	apiKey: process.env.OPENAI_API_KEY
});

export function resolveLanguageModel(
	modelId: SupportedModelId
): ReturnType<ReturnType<typeof createOpenAI>> {
	return openai(modelId);
}

export function resolveProviderOptions(
	modelId: SupportedModelId,
	reasoningEffort: SupportedReasoningEffort
) {
	if (!modelId.startsWith('gpt-5')) {
		return undefined;
	}

	return {
		openai: {
			reasoningEffort
		}
	} as const;
}
