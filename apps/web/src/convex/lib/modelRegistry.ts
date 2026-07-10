'use node';

import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import { type SupportedModelId } from '@convex/lib/models';
import type { LanguageModel } from 'ai';

const openai: OpenAIProvider = createOpenAI({
	apiKey: process.env.OPENAI_API_KEY
});

export function resolveLanguageModel(modelId: SupportedModelId): LanguageModel {
	return openai(modelId);
}
