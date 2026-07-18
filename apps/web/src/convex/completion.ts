'use node';

import { generateText, jsonSchema, streamText, tool, type ModelMessage } from 'ai';
import { v } from 'convex/values';
import { action, type ActionCtx } from '@convex/_generated/server';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import type { JsonValue } from '@convex/lib/json';
import { resolveLanguageModel, resolveProviderOptions } from '@convex/lib/modelRegistry';
import { assertRunAcceptsModelCompletion } from '@convex/lib/agentErrors';
import { isCurrentCompletionAttempt } from '@convex/lib/runLease';
import { enforceModelCompletionLimit } from '@convex/lib/rateLimits';
import { getUserId } from '@convex/lib/auth';
import { vModelId, vReasoningEffort, vServiceTier } from '@convex/lib/validators';
import {
	assertSupportedModelConfiguration,
	defaultServiceTier,
	type SupportedModelId,
	type SupportedReasoningEffort,
	type SupportedServiceTier
} from '@convex/lib/models';
import {
	appendCompletionStreamEvent,
	COMPLETION_STREAM_SUPERSEDED,
	type CompletionStreamEvent,
	isCompletionStreamAttemptSuperseded,
	isCompletionStreamSuperseded,
	upsertCompletionReasoningEvent,
	upsertCompletionTextEvent
} from '@convex/lib/completionStream';

type JsonSchema = Parameters<typeof jsonSchema>[0];
type ToolChoice = NonNullable<Parameters<typeof generateText>[0]['toolChoice']>;
type GenerateTextResult = Awaited<ReturnType<typeof generateText>>;
type CompletionActionResult = Pick<GenerateTextResult, 'text' | 'usage' | 'toolCalls'> & {
	response: GenerateTextResult['finalStep']['response'];
	streamEvents: CompletionStreamEvent[];
};
type CompletionRequest = Parameters<typeof generateText>[0];
type SharedCompletionRequest = Omit<CompletionRequest, 'prompt' | 'messages'>;

const COMPLETION_ACCEPTANCE_CHECK_INTERVAL_MS = 1_000;

export const complete = action({
	args: {
		modelId: vModelId,
		reasoningEffort: v.optional(vReasoningEffort),
		serviceTier: v.optional(vServiceTier),
		instructions: v.optional(v.string()),
		prompt: v.optional(v.string()),
		messagesJson: v.optional(v.string()),
		streamRunId: v.id('runs'),
		claimId: v.string(),
		attemptSeq: v.number(),
		streamId: v.string(),
		supersededStreamIds: v.optional(v.array(v.string())),
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
		tool_calls: Array<{
			id: string;
			name: string;
			arguments: JsonValue;
			provider_metadata?: JsonValue;
		}>;
		stream_events: CompletionStreamEvent[];
	}> => {
		await getUserId(ctx);
		// Register before any model work so a reconnect-replayed orphan dies
		// on the monotonic (claimId, attemptSeq) fence instead of racing the live attempt.
		await ctx.runMutation(api.agentRuntime.registerCompletionAttempt, {
			runId: args.streamRunId,
			claimId: args.claimId,
			attemptSeq: args.attemptSeq,
			...(args.supersededStreamIds !== undefined
				? { supersededStreamIds: args.supersededStreamIds }
				: {})
		});
		const modelId = args.modelId;
		if (args.reasoningEffort !== undefined || args.serviceTier !== undefined) {
			assertSupportedModelConfiguration({
				modelId,
				reasoningEffort: args.reasoningEffort,
				serviceTier: args.serviceTier ?? defaultServiceTier
			});
		}
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
			? reviveImageUrls(parseJson<SerializedModelMessage[]>(args.messagesJson, 'messagesJson'))
			: undefined;
		const toolChoice: ToolChoice | undefined = args.toolChoiceJson
			? parseJson<ToolChoice>(args.toolChoiceJson, 'toolChoiceJson')
			: undefined;
		if (args.prompt === undefined && messages === undefined) {
			throw new Error('Either prompt or messagesJson is required.');
		}
		const completionContext = await prepareCompletionContext(ctx, args.streamRunId);
		const sharedArgs = buildSharedCompletionRequest(
			{ ...args, modelId },
			tools,
			toolChoice,
			completionContext.promptCacheKey
		);
		let request: CompletionRequest;
		if (args.prompt !== undefined) {
			request = buildCompletionRequest(sharedArgs, args.prompt, undefined);
		} else if (messages !== undefined) {
			request = buildCompletionRequest(sharedArgs, undefined, messages);
		} else {
			throw new Error('Either prompt or messagesJson is required.');
		}

		const abortController = new AbortController();
		let result: CompletionActionResult;
		try {
			result = await collectStreamingCompletion(
				ctx,
				streamText({ ...request, abortSignal: abortController.signal }),
				{
					runId: args.streamRunId,
					claimId: args.claimId,
					attemptSeq: args.attemptSeq,
					streamId: args.streamId,
					initialSequence: completionContext.streamSequence
				},
				abortController
			);
		} catch (error) {
			abortController.abort(error);
			throw error;
		}

		return {
			text: result.text,
			usage: result.usage,
			message_id: result.response?.id,
			tool_calls: (result.toolCalls ?? []).map((toolCall: (typeof result.toolCalls)[number]) => ({
				id: toolCall.toolCallId,
				name: toolCall.toolName,
				arguments: toolCall.input as JsonValue,
				...(toolCall.providerMetadata
					? { provider_metadata: toolCall.providerMetadata as JsonValue }
					: {})
			})),
			stream_events: result.streamEvents
		};
	}
});

type CompletionAttempt = {
	runId: Id<'runs'>;
	claimId: string;
	attemptSeq: number;
	streamId: string;
	initialSequence: number;
};

async function collectStreamingCompletion(
	ctx: ActionCtx,
	result: ReturnType<typeof streamText>,
	attempt: CompletionAttempt,
	abortController: AbortController
): Promise<CompletionActionResult> {
	const { runId, claimId, attemptSeq, streamId, initialSequence } = attempt;
	const streamEvents: CompletionStreamEvent[] = [];
	const pendingEvents: CompletionStreamEvent[] = [];
	const reasoning = new Map<
		string,
		{ partId: string; providerMetadata?: JsonValue; finalized: boolean }
	>();
	let nextBatchSequence = initialSequence + 1;

	const flush = async (): Promise<void> => {
		if (pendingEvents.length === 0) {
			return;
		}
		const events = pendingEvents.slice();
		const sequence = nextBatchSequence;
		let lastError: unknown;
		for (let flushAttempt = 0; flushAttempt < 2; flushAttempt += 1) {
			try {
				const outcome = await ctx.runMutation(api.agentRuntime.mergeAssistantStreamEvents, {
					runId,
					claimId,
					attemptSeq,
					streamId,
					sequence,
					events
				});
				if (outcome === 'superseded') {
					throw new Error(COMPLETION_STREAM_SUPERSEDED);
				}
				pendingEvents.splice(0, events.length);
				nextBatchSequence += 1;
				return;
			} catch (error) {
				if (isCompletionStreamSuperseded(error)) throw error;
				lastError = error;
				if (flushAttempt === 0) await delay(100);
			}
		}
		throw lastError;
	};

	const queuePersisted = (event: CompletionStreamEvent): void => {
		if (event.type === 'text') {
			upsertCompletionTextEvent(pendingEvents, event);
		} else {
			appendCompletionStreamEvent(pendingEvents, event);
		}
	};
	const updateText = (id: string, text: string, providerMetadata?: JsonValue): void => {
		const event: Extract<CompletionStreamEvent, { type: 'text' }> = {
			type: 'text',
			id: `${streamId}:text:${id}`,
			text,
			turnId: streamId,
			...(providerMetadata !== undefined ? { providerMetadata } : {})
		};
		queuePersisted(event);
		upsertCompletionTextEvent(streamEvents, event);
	};
	const finalizeReasoning = (id: string, providerMetadata?: JsonValue): void => {
		const state = reasoning.get(id);
		if (!state || state.finalized) return;
		state.providerMetadata = providerMetadata ?? state.providerMetadata;
		state.finalized = true;
		const reasoningId = providerReasoningId(state.providerMetadata);
		upsertCompletionReasoningEvent(streamEvents, {
			type: 'reasoning',
			id: state.partId,
			text: '',
			turnId: streamId,
			...(reasoningId ? { providerReasoningId: reasoningId } : {}),
			...(state.providerMetadata ? { providerMetadata: state.providerMetadata } : {})
		});
	};

	const iterator = result.stream[Symbol.asyncIterator]();
	try {
		let nextPart = iterator.next();
		let nextAcceptanceCheckAt = Date.now() + COMPLETION_ACCEPTANCE_CHECK_INTERVAL_MS;
		while (true) {
			let next:
				| { type: 'part'; value: Awaited<typeof nextPart> }
				| { type: 'flush' }
				| { type: 'acceptance-check' };
			let flushTimer: ReturnType<typeof setTimeout> | undefined;
			let acceptanceTimer: ReturnType<typeof setTimeout> | undefined;
			const waits: Array<Promise<typeof next>> = [
				nextPart.then((value) => ({ type: 'part' as const, value })),
				new Promise<{ type: 'acceptance-check' }>((resolve) => {
					acceptanceTimer = setTimeout(
						() => resolve({ type: 'acceptance-check' }),
						Math.max(0, nextAcceptanceCheckAt - Date.now())
					);
				})
			];
			if (pendingEvents.length > 0) {
				const flushDeadline = new Promise<{ type: 'flush' }>((resolve) => {
					flushTimer = setTimeout(() => resolve({ type: 'flush' }), 80);
				});
				waits.push(flushDeadline);
			}
			try {
				next = await Promise.race(waits);
			} finally {
				if (flushTimer !== undefined) clearTimeout(flushTimer);
				if (acceptanceTimer !== undefined) clearTimeout(acceptanceTimer);
			}
			if (next.type === 'acceptance-check') {
				await assertCompletionStillAccepted(ctx, attempt);
				nextAcceptanceCheckAt = Date.now() + COMPLETION_ACCEPTANCE_CHECK_INTERVAL_MS;
				continue;
			}
			if (next.type === 'flush') {
				await flush();
				continue;
			}
			if (next.value.done) break;
			const part = next.value.value;
			nextPart = iterator.next();
			switch (part.type) {
				case 'text-start':
					updateText(part.id, '', part.providerMetadata as JsonValue | undefined);
					break;
				case 'text-delta':
					updateText(part.id, part.text, part.providerMetadata as JsonValue | undefined);
					break;
				case 'reasoning-start': {
					const providerMetadata = part.providerMetadata as JsonValue | undefined;
					reasoning.set(part.id, {
						partId: `${streamId}:reasoning:${part.id}`,
						providerMetadata,
						finalized: false
					});
					upsertCompletionReasoningEvent(streamEvents, {
						type: 'reasoning',
						id: `${streamId}:reasoning:${part.id}`,
						text: '',
						turnId: streamId,
						...(providerMetadata ? { providerMetadata } : {})
					});
					queuePersisted({
						type: 'reasoning',
						id: `${streamId}:reasoning:${part.id}`,
						text: '',
						turnId: streamId,
						...(providerMetadata ? { providerMetadata } : {})
					});
					break;
				}
				case 'reasoning-delta':
					if (!reasoning.has(part.id)) {
						reasoning.set(part.id, {
							partId: `${streamId}:reasoning:${part.id}`,
							finalized: false
						});
						upsertCompletionReasoningEvent(streamEvents, {
							type: 'reasoning',
							id: `${streamId}:reasoning:${part.id}`,
							text: '',
							turnId: streamId
						});
					}
					upsertCompletionReasoningEvent(streamEvents, {
						type: 'reasoning',
						id: `${streamId}:reasoning:${part.id}`,
						text: part.text,
						turnId: streamId
					});
					queuePersisted({
						type: 'reasoning',
						id: `${streamId}:reasoning:${part.id}`,
						text: part.text,
						turnId: streamId
					});
					break;
				case 'reasoning-end': {
					const providerMetadata = part.providerMetadata as JsonValue | undefined;
					if (!reasoning.has(part.id)) {
						reasoning.set(part.id, {
							partId: `${streamId}:reasoning:${part.id}`,
							providerMetadata,
							finalized: false
						});
						upsertCompletionReasoningEvent(streamEvents, {
							type: 'reasoning',
							id: `${streamId}:reasoning:${part.id}`,
							text: '',
							turnId: streamId
						});
					}
					queuePersisted({
						type: 'reasoning',
						id: `${streamId}:reasoning:${part.id}`,
						text: '',
						turnId: streamId,
						...(providerMetadata ? { providerMetadata } : {})
					});
					finalizeReasoning(part.id, providerMetadata);
					await flush();
					break;
				}
				case 'tool-input-start':
					queuePersisted({
						type: 'toolCall',
						partId: toolPartId(streamId, part.id),
						callId: part.id,
						name: part.toolName,
						input: {},
						turnId: streamId,
						...(part.providerMetadata
							? { providerMetadata: part.providerMetadata as JsonValue }
							: {})
					});
					await flush();
					break;
				case 'tool-call':
					queuePersisted({
						type: 'toolCall',
						partId: toolPartId(streamId, part.toolCallId),
						callId: part.toolCallId,
						name: part.toolName,
						input: part.input as JsonValue,
						turnId: streamId,
						...(part.providerMetadata
							? { providerMetadata: part.providerMetadata as JsonValue }
							: {})
					});
					appendCompletionStreamEvent(streamEvents, {
						type: 'toolCall',
						partId: toolPartId(streamId, part.toolCallId),
						callId: part.toolCallId,
						name: part.toolName,
						input: part.input as JsonValue,
						turnId: streamId,
						...(part.providerMetadata
							? { providerMetadata: part.providerMetadata as JsonValue }
							: {})
					});
					await flush();
					break;
				case 'text-end':
					updateText(part.id, '', part.providerMetadata as JsonValue | undefined);
					await flush();
					break;
				case 'tool-input-end':
					await flush();
					break;
				case 'finish-step':
				case 'finish':
					for (const id of reasoning.keys()) finalizeReasoning(id);
					await flush();
					break;
				case 'abort':
					throw new Error(part.reason ?? 'Model completion was aborted.');
				case 'error':
					throw part.error;
			}

			if (pendingEvents.length >= 24) {
				await flush();
			}
		}
		await flush();

		const [text, usage, finalStep, toolCalls] = await Promise.all([
			result.text,
			result.usage,
			result.finalStep,
			result.toolCalls
		]);
		return {
			text,
			usage,
			response: finalStep.response,
			toolCalls,
			streamEvents
		};
	} catch (error) {
		abortController.abort(error);
		try {
			await iterator.return?.();
		} catch {
			// Preserve the terminal stream error if iterator cleanup also fails.
		}
		if (isCompletionStreamSuperseded(error)) throw error;
		try {
			await flush();
		} catch {
			// Preserve the stream failure; the flush error is only secondary.
		}
		throw error;
	}
}

async function assertCompletionStillAccepted(
	ctx: ActionCtx,
	attempt: CompletionAttempt
): Promise<void> {
	const actor = await ctx.runQuery(api.agentRuntime.completionActor, {
		runId: attempt.runId
	});
	assertRunAcceptsModelCompletion(actor.status);
	if (!isCurrentCompletionAttempt(actor, attempt.claimId, attempt.attemptSeq)) {
		throw new Error(COMPLETION_STREAM_SUPERSEDED);
	}
	if (
		isCompletionStreamAttemptSuperseded({
			initialSequence: attempt.initialSequence,
			observedSequence: actor.streamSequence,
			observedStreamId: actor.streamAttemptId,
			streamId: attempt.streamId
		})
	) {
		throw new Error(COMPLETION_STREAM_SUPERSEDED);
	}
}

function toolPartId(streamId: string, toolCallId: string): string {
	return `${streamId}:tool:${toolCallId}`;
}

function providerReasoningId(metadata: JsonValue | undefined): string | undefined {
	if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
	const openai = metadata.openai;
	if (!openai || typeof openai !== 'object' || Array.isArray(openai)) return undefined;
	return typeof openai.itemId === 'string' ? openai.itemId : undefined;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function prepareCompletionContext(
	ctx: ActionCtx,
	runId: Id<'runs'>
): Promise<{ promptCacheKey: string; streamSequence: number }> {
	const actor = await ctx.runQuery(api.agentRuntime.completionActor, {
		runId
	});
	assertRunAcceptsModelCompletion(actor.status);
	await enforceModelCompletionLimit(ctx, actor.userId);
	return {
		promptCacheKey: `thread:${actor.threadId}`,
		streamSequence: actor.streamSequence
	};
}

function buildSharedCompletionRequest(
	args: {
		modelId: SupportedModelId;
		reasoningEffort?: SupportedReasoningEffort;
		serviceTier?: SupportedServiceTier;
		instructions?: string;
		tools?: Array<{ name: string }>;
	},
	tools: Record<string, ReturnType<typeof tool>>,
	toolChoice: ToolChoice | undefined,
	promptCacheKey: string
): SharedCompletionRequest {
	const serviceTier = args.serviceTier ?? defaultServiceTier;
	return {
		model: resolveLanguageModel(args.modelId, serviceTier, promptCacheKey),
		...(args.instructions !== undefined ? { instructions: args.instructions } : {}),
		...(args.tools?.length ? { tools } : {}),
		...(toolChoice !== undefined ? { toolChoice } : {}),
		providerOptions: resolveProviderOptions(
			args.modelId,
			args.reasoningEffort,
			serviceTier,
			promptCacheKey
		)
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
		throw new Error(`Invalid ${fieldName}: ${message}`, { cause: error });
	}
}

type SerializedModelMessage = Omit<ModelMessage, 'content'> & {
	content:
		| ModelMessage['content']
		| Array<{
				type: string;
				image?: unknown;
				[key: string]: unknown;
		  }>;
};

function reviveImageUrls(messages: SerializedModelMessage[]): ModelMessage[] {
	return messages.map((message) => {
		if (message.role !== 'user' || !Array.isArray(message.content)) {
			return message as ModelMessage;
		}
		return {
			...message,
			content: message.content.map((part) =>
				part.type === 'image' && typeof part.image === 'string'
					? { ...part, image: new URL(part.image) }
					: part
			)
		} as ModelMessage;
	});
}
