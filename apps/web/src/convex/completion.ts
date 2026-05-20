'use node';

import { generateText, jsonSchema, streamText, tool, type ModelMessage } from 'ai';
import { v } from 'convex/values';
import { action, type ActionCtx } from '@convex/_generated/server';
import { api, internal } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import type { JsonValue } from '@web-lib/types/json';
import {
	upsertAssistantToolCallPart,
	upsertAssistantToolResultPart,
	type AssistantPart as PersistedAssistantPart
} from '@web-lib/chat/assistant-parts';
import { resolveLanguageModel, resolveProviderOptions } from '@convex/lib/modelRegistry';
import { vModelId, vReasoningEffort } from '@convex/lib/validators';
import { type SupportedModelId, type SupportedReasoningEffort } from '@web-lib/chat/models';

type JsonSchema = Parameters<typeof jsonSchema>[0];
type ToolChoice = NonNullable<Parameters<typeof generateText>[0]['toolChoice']>;
type GenerateTextResult = Awaited<ReturnType<typeof generateText>>;
type CompletionActionResult = Pick<GenerateTextResult, 'text' | 'usage' | 'response' | 'toolCalls'>;
type CompletionRequest = Parameters<typeof generateText>[0];
type StreamingCompletionRequest = Parameters<typeof streamText>[0];
type SharedCompletionRequest = Omit<CompletionRequest, 'prompt' | 'messages'>;

export const complete = action({
	args: {
		modelId: vModelId,
		reasoningEffort: v.optional(vReasoningEffort),
		system: v.optional(v.string()),
		prompt: v.optional(v.string()),
		messagesJson: v.optional(v.string()),
		guestId: v.optional(v.string()),
		streamRunId: v.optional(v.id('runs')),
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
		let request: CompletionRequest & StreamingCompletionRequest;
		if (args.prompt !== undefined) {
			request = buildCompletionRequest(sharedArgs, args.prompt, undefined);
		} else if (messages !== undefined) {
			request = buildCompletionRequest(sharedArgs, undefined, messages);
		} else {
			throw new Error('Either prompt or messagesJson is required.');
		}

		const result: CompletionActionResult = args.streamRunId
			? await streamAndPersistDeltas(
					ctx,
					{ guestId: args.guestId, streamRunId: args.streamRunId },
					request
				)
			: await generateText(request);

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

const UPDATE_THROTTLE_MS = 120;
const UPDATE_MIN_DELTA_CHARS = 40;

async function streamAndPersistDeltas(
	ctx: ActionCtx,
	args: { guestId?: string; streamRunId: Id<'runs'> },
	request: Parameters<typeof streamText>[0]
): Promise<CompletionActionResult> {
	const existingMessage = await ctx.runQuery(internal.agentRuntime.getAssistantMessageState, {
		guestId: args.guestId,
		runId: args.streamRunId
	});
	const result = streamText(request);
	const parts: PersistedAssistantPart[] = (
		(existingMessage?.parts ?? []) as PersistedAssistantPart[]
	).map((part) => ({ ...part }));
	const textPartIndexById = new Map<string, number>();
	const reasoningPartIndexById = new Map<string, number>();
	const toolCallPartIndexByCallId = new Map<string, number>();
	const toolResultPartIndexByCallId = new Map<string, number>();
	for (const [index, part] of parts.entries()) {
		if (part.type === 'text') {
			textPartIndexById.set(part.id, index);
		} else if (part.type === 'reasoning') {
			reasoningPartIndexById.set(part.id, index);
		} else if (part.type === 'tool-call') {
			toolCallPartIndexByCallId.set(part.callId, index);
		} else if (part.type === 'tool-result') {
			toolResultPartIndexByCallId.set(part.callId, index);
		}
	}
	let lastPersistedLength = buildAssistantText(parts).length;
	let lastPersistedAt = Date.now();

	for await (const chunk of result.fullStream) {
		if (
			await ctx.runQuery(api.agentRuntime.isFinished, {
				guestId: args.guestId,
				runId: args.streamRunId
			})
		) {
			const text = buildAssistantText(parts);
			if (text.length !== lastPersistedLength) {
				await ctx.runMutation(internal.agentRuntime.updateAssistantMessage, {
					runId: args.streamRunId,
					text,
					parts
				});
			}
			throw new Error('Run is cancelled,');
		}

		if (chunk.type === 'text-start') {
			ensureTextPart(parts, textPartIndexById, chunk.id);
		}
		if (chunk.type === 'text-delta') {
			const textIndex = ensureTextPart(parts, textPartIndexById, chunk.id);
			const textPart = parts[textIndex];
			if (textPart?.type === 'text') {
				textPart.text += chunk.text;
			}
		}
		if (chunk.type === 'reasoning-start') {
			ensureReasoningPart(parts, reasoningPartIndexById, chunk.id);
		}
		if (chunk.type === 'reasoning-delta') {
			const reasoningIndex = ensureReasoningPart(parts, reasoningPartIndexById, chunk.id);
			const reasoningPart = parts[reasoningIndex];
			if (reasoningPart?.type === 'reasoning') {
				reasoningPart.text += chunk.text;
			}
		}
		if (chunk.type === 'tool-call') {
			upsertAssistantToolCallPart(
				parts,
				toolCallPartIndexByCallId,
				chunk.toolName,
				chunk.toolCallId,
				chunk.input
			);
		}
		if (chunk.type === 'tool-result') {
			upsertAssistantToolResultPart(parts, toolResultPartIndexByCallId, chunk.toolCallId, {
				name: 'toolName' in chunk ? chunk.toolName : undefined,
				output: chunk.output
			});
		}
		const text = buildAssistantText(parts);
		if (shouldPersistPartial(text, lastPersistedLength, lastPersistedAt)) {
			await ctx.runMutation(internal.agentRuntime.updateAssistantMessage, {
				guestId: args.guestId,
				runId: args.streamRunId,
				text,
				parts
			});
			lastPersistedLength = text.length;
			lastPersistedAt = Date.now();
		}
	}

	const text = buildAssistantText(parts);
	if (
		await ctx.runQuery(api.agentRuntime.isFinished, {
			guestId: args.guestId,
			runId: args.streamRunId
		})
	) {
		if (text.length !== lastPersistedLength) {
			await ctx.runMutation(internal.agentRuntime.updateAssistantMessage, {
				guestId: args.guestId,
				runId: args.streamRunId,
				text,
				parts
			});
		}
		throw new Error('Run is cancelled.');
	}
	if (text.length !== lastPersistedLength) {
		await ctx.runMutation(internal.agentRuntime.updateAssistantMessage, {
			guestId: args.guestId,
			runId: args.streamRunId,
			text,
			parts
		});
	}

	const [finalText, usage, response, toolCalls] = await Promise.all([
		result.text,
		result.usage,
		result.response,
		result.toolCalls
	]);

	return {
		text: text.length > 0 ? text : finalText,
		usage,
		response,
		toolCalls
	};
}

function shouldPersistPartial(text: string, persistedLength: number, persistedAt: number): boolean {
	if (text.length - persistedLength < UPDATE_MIN_DELTA_CHARS) {
		return false;
	}
	return Date.now() - persistedAt >= UPDATE_THROTTLE_MS;
}

function buildAssistantText(parts: PersistedAssistantPart[]): string {
	const textParts = parts.filter(
		(part): part is Extract<PersistedAssistantPart, { type: 'text' }> => {
			return part.type === 'text' && part.text.trim().length > 0;
		}
	);
	return textParts.map((part) => part.text).join('\n\n');
}

function ensureTextPart(
	parts: PersistedAssistantPart[],
	indexById: Map<string, number>,
	id: string
): number {
	const existingIndex = indexById.get(id);
	if (existingIndex !== undefined) {
		return existingIndex;
	}
	const nextIndex = parts.push({ type: 'text', id, text: '' }) - 1;
	indexById.set(id, nextIndex);
	return nextIndex;
}

function ensureReasoningPart(
	parts: PersistedAssistantPart[],
	indexById: Map<string, number>,
	id: string
): number {
	const existingIndex = indexById.get(id);
	if (existingIndex !== undefined) {
		return existingIndex;
	}
	const nextIndex = parts.push({ type: 'reasoning', id, text: '' }) - 1;
	indexById.set(id, nextIndex);
	return nextIndex;
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
): CompletionRequest & StreamingCompletionRequest;
function buildCompletionRequest(
	sharedArgs: SharedCompletionRequest,
	prompt: undefined,
	messages: ModelMessage[]
): CompletionRequest & StreamingCompletionRequest;
function buildCompletionRequest(
	sharedArgs: SharedCompletionRequest,
	prompt: string | undefined,
	messages: ModelMessage[] | undefined
): CompletionRequest & StreamingCompletionRequest {
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
