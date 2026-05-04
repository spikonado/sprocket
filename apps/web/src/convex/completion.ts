'use node';

import { generateText, jsonSchema, tool, type ModelMessage } from 'ai';
import { v } from 'convex/values';
import { action } from '@convex/_generated/server';
import { resolveLanguageModel, resolveProviderOptions } from '@convex/lib/modelRegistry';
import { vModelId, vReasoningEffort } from '@convex/lib/validators';

type JsonSchema = Parameters<typeof jsonSchema>[0];
type ToolChoice = NonNullable<Parameters<typeof generateText>[0]['toolChoice']>;

export const complete = action({
	args: {
		modelId: vModelId,
		reasoningEffort: v.optional(vReasoningEffort),
		system: v.optional(v.string()),
		prompt: v.optional(v.string()),
		messagesJson: v.optional(v.string()),
		tools: v.optional(
			v.array(
				v.object({
					name: v.string(),
					description: v.string(),
					parametersJson: v.string()
				})
			)
		),
		toolChoiceJson: v.optional(v.string())
	},
	handler: async (_ctx, args) => {
		const tools = Object.fromEntries(
			(args.tools ?? []).map((toolDefinition) => [
				toolDefinition.name,
				tool({
					description: toolDefinition.description,
					inputSchema: jsonSchema(
						parseJson<JsonSchema>(toolDefinition.parametersJson, 'tools.parametersJson')
					)
				})
			])
		);
		const messages = args.messagesJson
			? parseJson<ModelMessage[]>(args.messagesJson, 'messagesJson')
			: undefined;
		const toolChoice = args.toolChoiceJson
			? parseJson<ToolChoice>(args.toolChoiceJson, 'toolChoiceJson')
			: undefined;
		const sharedArgs = {
			model: resolveLanguageModel(args.modelId),
			...(args.system ? { system: args.system } : {}),
			...(args.tools?.length ? { tools } : {}),
			...(toolChoice ? { toolChoice } : {}),
			...(args.reasoningEffort
				? {
						providerOptions: resolveProviderOptions(args.modelId, args.reasoningEffort)
					}
				: {})
		};
		const result = args.prompt
			? await generateText({
					...sharedArgs,
					prompt: args.prompt
				})
			: messages
				? await generateText({
						...sharedArgs,
						messages
					})
				: (() => {
						throw new Error('Either prompt or messagesJson is required.');
					})();

		return {
			text: result.text,
			usage: {
				input_tokens: result.usage?.inputTokens ?? 0,
				output_tokens: result.usage?.outputTokens ?? 0,
				total_tokens: result.usage?.totalTokens ?? 0
			},
			message_id: result.response?.id,
			tool_calls: (result.toolCalls ?? []).map((toolCall: (typeof result.toolCalls)[number]) => ({
				id: toolCall.toolCallId,
				name: toolCall.toolName,
				arguments: toolCall.input
			}))
		};
	}
});

function parseJson<T>(json: string, fieldName: string): T {
	try {
		return JSON.parse(json) as T;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid ${fieldName}: ${message}`);
	}
}
