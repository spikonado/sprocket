'use node';

import { generateText, jsonSchema, streamText, tool, type ModelMessage } from 'ai';
import { v } from 'convex/values';
import { action, type ActionCtx } from '@convex/_generated/server';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import {
	upsertAssistantToolCallPart,
	upsertAssistantToolResultPart,
	type AssistantPart as PersistedAssistantPart
} from '../lib/assistant-tool-parts';
import { resolveLanguageModel, resolveProviderOptions } from '@convex/lib/modelRegistry';
import { vModelId, vReasoningEffort } from '@convex/lib/validators';

type JsonSchema = Parameters<typeof jsonSchema>[0];
type ToolChoice = NonNullable<Parameters<typeof generateText>[0]['toolChoice']>;
type GenerateTextResult = Awaited<ReturnType<typeof generateText>>;
type CompletionActionResult = Pick<GenerateTextResult, 'text' | 'usage' | 'response' | 'toolCalls'>;

export const complete = action({
	args: {
		modelId: vModelId,
		reasoningEffort: v.optional(vReasoningEffort),
		system: v.optional(v.string()),
		prompt: v.optional(v.string()),
		messagesJson: v.optional(v.string()),
		guestId: v.optional(v.string()),
		streamMessageId: v.optional(v.id('threadMessages')),
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
		tool_calls: Array<{ id: string; name: string; arguments: unknown }>;
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
		const requestInput = args.prompt ? { prompt: args.prompt } : messages ? { messages } : null;
		if (!requestInput) {
			throw new Error('Either prompt or messagesJson is required.');
		}

		const result: CompletionActionResult = args.streamMessageId
			? await streamAndPersistDeltas(ctx, args, {
					...sharedArgs,
					...requestInput
				})
			: await generateText({
					...sharedArgs,
					...requestInput
				});

		return {
			text: result.text,
			usage: result.usage,
			message_id: result.response?.id,
			tool_calls: (result.toolCalls ?? []).map((toolCall: (typeof result.toolCalls)[number]) => ({
				id: toolCall.toolCallId,
				name: toolCall.toolName,
				arguments: toolCall.input
			}))
		};
	}
});

const UPDATE_THROTTLE_MS = 120;
const UPDATE_MIN_DELTA_CHARS = 40;

async function streamAndPersistDeltas(
	ctx: ActionCtx,
	args: { guestId?: string; streamMessageId?: Id<'threadMessages'> },
	request: Parameters<typeof streamText>[0]
): Promise<CompletionActionResult> {
	const existingMessage: Awaited<
		ReturnType<typeof ctx.runQuery<typeof api.agentRuntime.getAssistantMessage>>
	> | null = args.streamMessageId
		? await ctx.runQuery(api.agentRuntime.getAssistantMessage, {
				...(args.guestId ? { guestId: args.guestId } : {}),
				messageId: args.streamMessageId
			})
		: null;
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
	let lastPersistedLength = 0;
	let lastPersistedAt = 0;

	for await (const chunk of result.fullStream) {
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
			await persistAssistantDelta(ctx, args, text, parts);
			lastPersistedLength = text.length;
			lastPersistedAt = Date.now();
		}
	}

	const text = buildAssistantText(parts);
	if (text.length !== lastPersistedLength) {
		await persistAssistantDelta(ctx, args, text, pruneAssistantParts(parts));
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

async function persistAssistantDelta(
	ctx: ActionCtx,
	args: { guestId?: string; streamMessageId?: Id<'threadMessages'> },
	text: string,
	parts?: PersistedAssistantPart[]
) {
	if (!args.streamMessageId) {
		return;
	}
	await ctx.runMutation(api.agentRuntime.updateAssistantMessage, {
		...(args.guestId ? { guestId: args.guestId } : {}),
		messageId: args.streamMessageId,
		text,
		...(parts ? { parts: pruneAssistantParts(parts) } : {})
	});
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

function pruneAssistantParts(parts: PersistedAssistantPart[]): PersistedAssistantPart[] {
	return parts.filter((part) => {
		if (part.type === 'text' || part.type === 'reasoning') {
			return part.text.trim().length > 0;
		}
		return true;
	});
}

function parseJson<T>(json: string, fieldName: string): T {
	try {
		return JSON.parse(json) as T;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid ${fieldName}: ${message}`);
	}
}
