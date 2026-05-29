'use node';

import { generateText, jsonSchema, streamText, tool, type ModelMessage } from 'ai';
import { v } from 'convex/values';
import { action, type ActionCtx } from '@convex/_generated/server';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import type { JsonValue } from '@convex/lib/json';
import { resolveLanguageModel, resolveProviderOptions } from '@convex/lib/modelRegistry';
import { assertRunAcceptsModelCompletion } from '@convex/lib/agentErrors';
import {
	enforceGuestModelCompletionLimit,
	enforceSignedInModelCompletionLimit
} from '@convex/lib/rateLimits';
import { vModelId, vReasoningEffort } from '@convex/lib/validators';
import { type SupportedModelId, type SupportedReasoningEffort } from '@convex/lib/models';

type JsonSchema = Parameters<typeof jsonSchema>[0];
type ToolChoice = NonNullable<Parameters<typeof generateText>[0]['toolChoice']>;
type GenerateTextResult = Awaited<ReturnType<typeof generateText>>;
type CompletionActionResult = Pick<GenerateTextResult, 'text' | 'usage' | 'response' | 'toolCalls'>;
type CompletionRequest = Parameters<typeof generateText>[0];
type SharedCompletionRequest = Omit<CompletionRequest, 'prompt' | 'messages'>;

export const complete = action({
	args: {
		modelId: vModelId,
		reasoningEffort: v.optional(vReasoningEffort),
		system: v.optional(v.string()),
		prompt: v.optional(v.string()),
		messagesJson: v.optional(v.string()),
		guestId: v.optional(v.string()),
		streamRunId: v.id('runs'),
		toolChoiceJson: v.optional(v.string()),
		tools: v.optional(
			v.array(
				v.object({
					name: v.string(),
					description: v.string(),
					parametersJson: v.string()
				})
			)
		)
	},
	handler: async (
		ctx,
		args
	): Promise<{
		text: string;
		usage: CompletionActionResult['usage'];
		message_id: string | undefined;
		tool_calls: Array<{ id: string; name: string; arguments: JsonValue }>;
	}> => {
		const tools: Record<string, ReturnType<typeof tool>> = Object.fromEntries(
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
		const messages: ModelMessage[] | undefined = args.messagesJson
			? parseJson<ModelMessage[]>(args.messagesJson, 'messagesJson')
			: undefined;
		const toolChoice: ToolChoice | undefined = args.toolChoiceJson
			? parseJson<ToolChoice>(args.toolChoiceJson, 'toolChoiceJson')
			: undefined;
		const sharedArgs = buildSharedCompletionRequest(args, tools, toolChoice);
		let request: CompletionRequest;
		if (args.prompt !== undefined) {
			request = buildCompletionRequest(sharedArgs, args.prompt, undefined);
		} else if (messages !== undefined) {
			request = buildCompletionRequest(sharedArgs, undefined, messages);
		} else {
			throw new Error('Either prompt or messagesJson is required.');
		}

		await enforceCompletionLimit(ctx, args.guestId, args.streamRunId);
		const result = await collectStreamingCompletion(streamText(request));

		return {
			text: result.text,
			usage: result.usage,
			message_id: result.response?.id,
			tool_calls: (result.toolCalls ?? []).map((toolCall: (typeof result.toolCalls)[number]) => ({
				id: toolCall.toolCallId,
				name: toolCall.toolName,
				arguments: toolCall.input as JsonValue
			}))
		};
	}
});

async function collectStreamingCompletion(
	result: ReturnType<typeof streamText>
): Promise<CompletionActionResult> {
	const [text, usage, response, toolCalls] = await Promise.all([
		result.text,
		result.usage,
		result.response,
		result.toolCalls
	]);
	return {
		text,
		usage,
		response,
		toolCalls
	} as CompletionActionResult;
}

async function enforceCompletionLimit(
	ctx: ActionCtx,
	guestId: string | undefined,
	runId: Id<'runs'>
): Promise<void> {
	const actor = await ctx.runQuery(api.agentRuntime.completionActor, {
		...(guestId ? { guestId } : {}),
		runId
	});
	assertRunAcceptsModelCompletion(actor.status);
	if (actor.userId.startsWith('guest:')) {
		await enforceGuestModelCompletionLimit(ctx, actor.userId);
		return;
	}
	await enforceSignedInModelCompletionLimit(ctx, actor.userId);
}

function buildSharedCompletionRequest(
	args: {
		modelId: SupportedModelId;
		reasoningEffort?: SupportedReasoningEffort;
		system?: string;
		tools?: Array<{ name: string }>;
	},
	tools: Record<string, ReturnType<typeof tool>>,
	toolChoice: ToolChoice | undefined
): SharedCompletionRequest {
	return {
		model: resolveLanguageModel(args.modelId),
		...(args.system !== undefined ? { system: args.system } : {}),
		...(args.tools?.length ? { tools } : {}),
		...(toolChoice !== undefined ? { toolChoice } : {}),
		...(args.reasoningEffort !== undefined
			? {
					providerOptions: resolveProviderOptions(args.modelId, args.reasoningEffort)
				}
			: {})
	};
}

function buildCompletionRequest(
	sharedArgs: SharedCompletionRequest,
	prompt: string,
	messages: undefined
): CompletionRequest;
function buildCompletionRequest(
	sharedArgs: SharedCompletionRequest,
	prompt: undefined,
	messages: ModelMessage[]
): CompletionRequest;
function buildCompletionRequest(
	sharedArgs: SharedCompletionRequest,
	prompt: string | undefined,
	messages: ModelMessage[] | undefined
): CompletionRequest {
	if (prompt !== undefined) {
		return { ...sharedArgs, prompt };
	}
	if (messages !== undefined) {
		return { ...sharedArgs, messages };
	}
	throw new Error('Either prompt or messagesJson is required.');
}

function parseJson<T>(json: string, fieldName: string): T {
	try {
		return JSON.parse(json) as T;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid ${fieldName}: ${message}`);
	}
}
