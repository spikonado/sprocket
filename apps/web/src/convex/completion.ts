'use node';

import { generateText, jsonSchema, streamText, tool, type ModelMessage } from 'ai';
import { ConvexError, v } from 'convex/values';
import { action, type ActionCtx } from '@convex/_generated/server';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { isJsonObject, isJsonString, isJsonValue, type JsonValue } from '@convex/lib/json';
import { resolveLanguageModel, resolveProviderOptions } from '@convex/lib/modelRegistry';
import {
	RUN_NO_LONGER_ACTIVE,
	assertRunAcceptsModelCompletion,
	toModelCompletionConvexError
} from '@convex/lib/agentErrors';
import {
	isCurrentCompletionAttempt,
	isRunClaimLeaseActive,
	ownsActiveRunClaim
} from '@convex/lib/runLease';
import { chargeModelUsage, checkModelUsageLimit } from '@convex/lib/rateLimits';
import { vCompleteActionResult, vSummarizeActionResult } from '@convex/lib/docs';
import { vModelId, vReasoningEffort, vServiceTier } from '@convex/lib/validators';
import {
	assertSupportedModelConfiguration,
	coercePersistedReasoningEffort,
	defaultServiceTier,
	normalizeCompletionUsage,
	type SupportedModelId,
	type SupportedReasoningEffort,
	type SupportedServiceTier
} from '@convex/lib/models';
import {
	COMPACTION_MAX_OUTPUT_TOKENS,
	CONTEXT_COMPACTION_INSTRUCTIONS
} from '@convex/lib/contextCompaction';
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

const SUMMARIZE_ACCEPTANCE_CHECK_INTERVAL_MS = 5_000;
// Every persisted flush is already fenced against cancel/supersede, so only
// poll while the provider stream is silent (no flushes happening).
const COMPLETION_ACCEPTANCE_CHECK_LULL_MS = 10_000;
// Non-persisted parts (tool-input deltas) postpone the lull without producing
// fenced flushes, so cap the gap regardless.
const COMPLETION_ACCEPTANCE_CHECK_MAX_INTERVAL_MS = 30_000;
// Persisting a growing message rewrites and reactively rereads the whole document.
// Keep the UI responsive without paying that cost for every token-sized provider delta.
const COMPLETION_STREAM_FLUSH_INTERVAL_MS = 500;
// AI SDK retries only retryable provider failures and honors Retry-After headers.
// Allow a longer recovery window for short provider rate-limit bursts.
const MODEL_PROVIDER_MAX_RETRIES = 5;

type StreamTextFn = typeof streamText;
type GenerateTextFn = typeof generateText;
type CompletionModelFnSlot = typeof globalThis & {
	__sprocketStreamText?: StreamTextFn;
	__sprocketGenerateText?: GenerateTextFn;
};
type CompletionAttemptRegistration = {
	runId: Id<'runs'>;
	claimId: string;
	attemptSeq: number;
	executionSecret: string;
	supersededStreamIds?: string[];
};
type CompletionToolCallResult = {
	id: string;
	name: string;
	arguments: JsonValue;
	provider_metadata?: JsonValue;
};

// SAFETY: only test suites assign __sprocket* on globalThis; production never writes this slot.
const completionModelFns = globalThis as CompletionModelFnSlot;

function streamTextImpl(...args: Parameters<StreamTextFn>): ReturnType<StreamTextFn> {
	return (completionModelFns.__sprocketStreamText ?? streamText)(...args);
}

function generateTextImpl(...args: Parameters<GenerateTextFn>): ReturnType<GenerateTextFn> {
	return (completionModelFns.__sprocketGenerateText ?? generateText)(...args);
}

export function bindCompletionModelFns(bindings: {
	streamText?: StreamTextFn;
	generateText?: GenerateTextFn;
}): () => void {
	const previousStreamText = completionModelFns.__sprocketStreamText;
	const previousGenerateText = completionModelFns.__sprocketGenerateText;
	if ('streamText' in bindings) {
		completionModelFns.__sprocketStreamText = bindings.streamText;
	}
	if ('generateText' in bindings) {
		completionModelFns.__sprocketGenerateText = bindings.generateText;
	}
	return () => {
		completionModelFns.__sprocketStreamText = previousStreamText;
		completionModelFns.__sprocketGenerateText = previousGenerateText;
	};
}

function toJsonValue<T>(value: T): JsonValue | undefined {
	if (value === undefined) return undefined;
	try {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) return undefined;
		const parsed = JSON.parse(serialized);
		return isJsonValue(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

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
		executionSecret: v.string(),
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
	returns: vCompleteActionResult,
	handler: async (ctx, args) => {
		// Register before any model work so a reconnect-replayed orphan dies
		// on the monotonic (claimId, attemptSeq) fence instead of racing the live attempt.
		const registration: CompletionAttemptRegistration = {
			runId: args.streamRunId,
			claimId: args.claimId,
			attemptSeq: args.attemptSeq,
			executionSecret: args.executionSecret
		};
		if (args.supersededStreamIds !== undefined) {
			registration.supersededStreamIds = args.supersededStreamIds;
		}
		await ctx.runMutation(api.agentRuntime.registerCompletionAttempt, registration);
		const modelId = args.modelId;
		const reasoningEffort = coercePersistedReasoningEffort(modelId, args.reasoningEffort);
		const serviceTier = args.serviceTier ?? defaultServiceTier;
		if (reasoningEffort !== undefined || args.serviceTier !== undefined) {
			assertSupportedModelConfiguration({
				modelId,
				reasoningEffort,
				serviceTier
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
		const completionContext = await prepareCompletionContext(
			ctx,
			args.streamRunId,
			args.executionSecret,
			modelId
		);
		const sharedArgs = buildSharedCompletionRequest(
			{ ...args, modelId, serviceTier, reasoningEffort },
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
				streamTextImpl({ ...request, abortSignal: abortController.signal }),
				{
					runId: args.streamRunId,
					claimId: args.claimId,
					attemptSeq: args.attemptSeq,
					streamId: args.streamId,
					executionSecret: args.executionSecret,
					initialSequence: completionContext.streamSequence
				},
				abortController
			);
		} catch (error) {
			abortController.abort(error);
			throw toModelCompletionConvexError(
				error instanceof Error ? error : new Error(String(error)),
				modelId
			);
		}
		await chargeModelUsage(ctx, {
			userId: completionContext.userId,
			modelId,
			serviceTier,
			tokens: normalizeCompletionUsage(result.usage)
		});

		return {
			text: result.text,
			usage: result.usage,
			message_id: result.response?.id,
			tool_calls: (result.toolCalls ?? []).map((toolCall: (typeof result.toolCalls)[number]) => {
				const mapped: CompletionToolCallResult = {
					id: toolCall.toolCallId,
					name: toolCall.toolName,
					arguments: toJsonValue(toolCall.input) ?? {}
				};
				const providerMetadata = toJsonValue(toolCall.providerMetadata);
				if (providerMetadata !== undefined) mapped.provider_metadata = providerMetadata;
				return mapped;
			}),
			stream_events: result.streamEvents
		};
	}
});

type SummarizeClaim = {
	runId: Id<'runs'>;
	claimId: string;
	executionSecret: string;
};

export const summarize = action({
	args: {
		modelId: vModelId,
		reasoningEffort: v.optional(vReasoningEffort),
		serviceTier: v.optional(vServiceTier),
		messagesJson: v.string(),
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: vSummarizeActionResult,
	handler: async (ctx, args) => {
		const modelId = args.modelId;
		const reasoningEffort = coercePersistedReasoningEffort(modelId, args.reasoningEffort);
		const serviceTier = args.serviceTier ?? defaultServiceTier;
		if (reasoningEffort !== undefined || args.serviceTier !== undefined) {
			assertSupportedModelConfiguration({
				modelId,
				reasoningEffort,
				serviceTier
			});
		}
		const claim: SummarizeClaim = {
			runId: args.runId,
			claimId: args.claimId,
			executionSecret: args.executionSecret
		};
		const completionContext = await prepareCompletionContext(
			ctx,
			args.runId,
			args.executionSecret,
			modelId
		);
		await assertSummarizeStillAccepted(ctx, claim);
		const messages = reviveImageUrls(
			parseJson<SerializedModelMessage[]>(args.messagesJson, 'messagesJson')
		);
		const sharedArgs = buildSharedCompletionRequest(
			{
				modelId,
				reasoningEffort,
				serviceTier,
				instructions: CONTEXT_COMPACTION_INSTRUCTIONS
			},
			{},
			undefined,
			completionContext.promptCacheKey
		);
		const abortController = new AbortController();
		let result: GenerateTextResult;
		try {
			result = await waitForCompletionWithAcceptance(
				ctx,
				generateTextImpl({
					...sharedArgs,
					messages,
					maxOutputTokens: COMPACTION_MAX_OUTPUT_TOKENS,
					abortSignal: abortController.signal
				}),
				claim,
				abortController
			);
		} catch (error) {
			throw toModelCompletionConvexError(
				error instanceof Error ? error : new Error(String(error)),
				modelId
			);
		}
		const summary = result.text.trim();
		if (!summary) throw new Error('The model returned an empty context summary.');
		await assertSummarizeStillAccepted(ctx, claim);
		await chargeModelUsage(ctx, {
			userId: completionContext.userId,
			modelId,
			serviceTier,
			tokens: normalizeCompletionUsage(result.usage)
		});
		await checkModelUsageLimit(ctx, completionContext.userId, modelId);
		return { summary, usage: result.usage };
	}
});

type CompletionAttempt = {
	runId: Id<'runs'>;
	claimId: string;
	attemptSeq: number;
	streamId: string;
	executionSecret: string;
	initialSequence: number;
};

async function collectStreamingCompletion(
	ctx: ActionCtx,
	result: ReturnType<typeof streamText>,
	attempt: CompletionAttempt,
	abortController: AbortController
): Promise<CompletionActionResult> {
	const { runId, claimId, attemptSeq, streamId, executionSecret, initialSequence } = attempt;
	const streamEvents: CompletionStreamEvent[] = [];
	const pendingEvents: CompletionStreamEvent[] = [];
	const reasoning = new Map<
		string,
		{ partId: string; providerMetadata?: JsonValue; finalized: boolean }
	>();
	let nextBatchSequence = initialSequence + 1;
	let nextFlushAt: number | undefined;

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
					executionSecret,
					events
				});
				if (outcome === 'superseded') {
					throw new ConvexError(COMPLETION_STREAM_SUPERSEDED);
				}
				pendingEvents.splice(0, events.length);
				nextFlushAt = pendingEvents.length
					? Date.now() + COMPLETION_STREAM_FLUSH_INTERVAL_MS
					: undefined;
				nextBatchSequence += 1;
				return;
			} catch (error) {
				if (isCompletionStreamSuperseded(error instanceof Error ? error : String(error))) {
					throw error;
				}
				lastError = error;
				if (flushAttempt === 0) await delay(100);
			}
		}
		throw lastError;
	};

	const queuePersisted = (event: CompletionStreamEvent): void => {
		if (pendingEvents.length === 0) {
			nextFlushAt = Date.now() + COMPLETION_STREAM_FLUSH_INTERVAL_MS;
		}
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
			turnId: streamId
		};
		if (providerMetadata !== undefined) event.providerMetadata = providerMetadata;
		queuePersisted(event);
		upsertCompletionTextEvent(streamEvents, event);
	};
	const finalizeReasoning = (id: string, providerMetadata?: JsonValue): void => {
		const state = reasoning.get(id);
		if (!state || state.finalized) return;
		state.providerMetadata = providerMetadata ?? state.providerMetadata;
		state.finalized = true;
		const reasoningId = providerReasoningId(state.providerMetadata);
		const finalized: Extract<CompletionStreamEvent, { type: 'reasoning' }> = {
			type: 'reasoning',
			id: state.partId,
			text: '',
			turnId: streamId
		};
		if (reasoningId) finalized.providerReasoningId = reasoningId;
		if (state.providerMetadata) finalized.providerMetadata = state.providerMetadata;
		upsertCompletionReasoningEvent(streamEvents, finalized);
	};

	const iterator = result.stream[Symbol.asyncIterator]();
	try {
		let nextPart = iterator.next();
		let lastStreamPartAt = Date.now();
		let lastAcceptanceCheckAt = lastStreamPartAt;
		let nextAcceptanceCheckAt = lastStreamPartAt + COMPLETION_ACCEPTANCE_CHECK_LULL_MS;
		while (true) {
			if (pendingEvents.length > 0 && nextFlushAt !== undefined && Date.now() >= nextFlushAt) {
				await flush();
				continue;
			}
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
					flushTimer = setTimeout(
						() => resolve({ type: 'flush' }),
						Math.max(0, (nextFlushAt ?? Date.now()) - Date.now())
					);
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
				const now = Date.now();
				if (
					now - lastStreamPartAt >= COMPLETION_ACCEPTANCE_CHECK_LULL_MS ||
					now - lastAcceptanceCheckAt >= COMPLETION_ACCEPTANCE_CHECK_MAX_INTERVAL_MS
				) {
					await assertCompletionStillAccepted(ctx, attempt);
					lastAcceptanceCheckAt = now;
					nextAcceptanceCheckAt = now + COMPLETION_ACCEPTANCE_CHECK_LULL_MS;
				} else {
					nextAcceptanceCheckAt = Math.min(
						lastStreamPartAt + COMPLETION_ACCEPTANCE_CHECK_LULL_MS,
						lastAcceptanceCheckAt + COMPLETION_ACCEPTANCE_CHECK_MAX_INTERVAL_MS
					);
				}
				continue;
			}
			if (next.type === 'flush') {
				await flush();
				continue;
			}
			if (next.value.done) break;
			const part = next.value.value;
			nextPart = iterator.next();
			lastStreamPartAt = Date.now();
			const partMetadata =
				'providerMetadata' in part ? toJsonValue(part.providerMetadata) : undefined;
			switch (part.type) {
				case 'text-start':
					updateText(part.id, '', partMetadata);
					break;
				case 'text-delta':
					updateText(part.id, part.text, partMetadata);
					break;
				case 'reasoning-start': {
					reasoning.set(part.id, {
						partId: `${streamId}:reasoning:${part.id}`,
						providerMetadata: partMetadata,
						finalized: false
					});
					const started: Extract<CompletionStreamEvent, { type: 'reasoning' }> = {
						type: 'reasoning',
						id: `${streamId}:reasoning:${part.id}`,
						text: '',
						turnId: streamId
					};
					if (partMetadata) started.providerMetadata = partMetadata;
					upsertCompletionReasoningEvent(streamEvents, started);
					queuePersisted(started);
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
					if (!reasoning.has(part.id)) {
						reasoning.set(part.id, {
							partId: `${streamId}:reasoning:${part.id}`,
							providerMetadata: partMetadata,
							finalized: false
						});
						upsertCompletionReasoningEvent(streamEvents, {
							type: 'reasoning',
							id: `${streamId}:reasoning:${part.id}`,
							text: '',
							turnId: streamId
						});
					}
					const ended: Extract<CompletionStreamEvent, { type: 'reasoning' }> = {
						type: 'reasoning',
						id: `${streamId}:reasoning:${part.id}`,
						text: '',
						turnId: streamId
					};
					if (partMetadata) ended.providerMetadata = partMetadata;
					queuePersisted(ended);
					finalizeReasoning(part.id, partMetadata);
					await flush();
					break;
				}
				case 'tool-input-start': {
					const startedCall: Extract<CompletionStreamEvent, { type: 'toolCall' }> = {
						type: 'toolCall',
						partId: toolPartId(streamId, part.id),
						callId: part.id,
						name: part.toolName,
						input: {},
						turnId: streamId
					};
					if (partMetadata) startedCall.providerMetadata = partMetadata;
					queuePersisted(startedCall);
					await flush();
					break;
				}
				case 'tool-call': {
					const toolCall: Extract<CompletionStreamEvent, { type: 'toolCall' }> = {
						type: 'toolCall',
						partId: toolPartId(streamId, part.toolCallId),
						callId: part.toolCallId,
						name: part.toolName,
						input: toJsonValue(part.input) ?? {},
						turnId: streamId
					};
					if (partMetadata) toolCall.providerMetadata = partMetadata;
					queuePersisted(toolCall);
					appendCompletionStreamEvent(streamEvents, toolCall);
					await flush();
					break;
				}
				case 'text-end':
					updateText(part.id, '', partMetadata);
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
		if (isCompletionStreamSuperseded(error instanceof Error ? error : String(error))) throw error;
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
		runId: attempt.runId,
		executionSecret: attempt.executionSecret
	});
	assertRunAcceptsModelCompletion(actor.status);
	if (!isRunClaimLeaseActive(actor, Date.now())) {
		throw new ConvexError(RUN_NO_LONGER_ACTIVE);
	}
	if (!isCurrentCompletionAttempt(actor, attempt.claimId, attempt.attemptSeq)) {
		throw new ConvexError(COMPLETION_STREAM_SUPERSEDED);
	}
	if (
		isCompletionStreamAttemptSuperseded({
			initialSequence: attempt.initialSequence,
			observedSequence: actor.streamSequence,
			observedStreamId: actor.streamAttemptId,
			streamId: attempt.streamId
		})
	) {
		throw new ConvexError(COMPLETION_STREAM_SUPERSEDED);
	}
}

async function assertSummarizeStillAccepted(ctx: ActionCtx, claim: SummarizeClaim): Promise<void> {
	const actor = await ctx.runQuery(api.agentRuntime.completionActor, {
		runId: claim.runId,
		executionSecret: claim.executionSecret
	});
	assertRunAcceptsModelCompletion(actor.status);
	if (!ownsActiveRunClaim(actor, claim.claimId, Date.now())) {
		throw new ConvexError(RUN_NO_LONGER_ACTIVE);
	}
}

async function waitForCompletionWithAcceptance<T>(
	ctx: ActionCtx,
	completion: Promise<T>,
	claim: SummarizeClaim,
	abortController: AbortController
): Promise<T> {
	while (true) {
		const outcome = await Promise.race([
			completion.then((value) => ({ type: 'completed' as const, value })),
			delay(SUMMARIZE_ACCEPTANCE_CHECK_INTERVAL_MS).then(() => ({ type: 'check' as const }))
		]);
		if (outcome.type === 'completed') return outcome.value;
		try {
			await assertSummarizeStillAccepted(ctx, claim);
		} catch (error) {
			abortController.abort(error);
			throw error;
		}
	}
}

function toolPartId(streamId: string, toolCallId: string): string {
	return `${streamId}:tool:${toolCallId}`;
}

function providerReasoningId(metadata: JsonValue | undefined): string | undefined {
	if (!isJsonObject(metadata) || !isJsonObject(metadata.openai)) return undefined;
	return isJsonString(metadata.openai.itemId) ? metadata.openai.itemId : undefined;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function prepareCompletionContext(
	ctx: ActionCtx,
	runId: Id<'runs'>,
	executionSecret: string,
	modelId: SupportedModelId
): Promise<{ promptCacheKey: string; streamSequence: number; userId: string }> {
	const actor = await ctx.runQuery(api.agentRuntime.completionActor, {
		runId,
		executionSecret
	});
	assertRunAcceptsModelCompletion(actor.status);
	await checkModelUsageLimit(ctx, actor.userId, modelId);
	return {
		promptCacheKey: `thread:${actor.threadId}`,
		streamSequence: actor.streamSequence,
		userId: actor.userId
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
	const request: SharedCompletionRequest = {
		model: resolveLanguageModel(args.modelId, serviceTier),
		maxRetries: MODEL_PROVIDER_MAX_RETRIES,
		providerOptions: resolveProviderOptions(
			args.modelId,
			args.reasoningEffort,
			serviceTier,
			promptCacheKey
		)
	};
	if (args.instructions !== undefined) request.instructions = args.instructions;
	if (args.tools?.length) request.tools = tools;
	if (toolChoice !== undefined) request.toolChoice = toolChoice;
	return request;
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
		// SAFETY: arguments arrive as JSON strings written by our own client; T is the documented contract and is not re-validated here.
		return JSON.parse(json) as T;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid ${fieldName}: ${message}`, { cause: error });
	}
}

type SerializedImagePart = {
	type: string;
	image?: string;
};

type SerializedModelMessage = Omit<ModelMessage, 'content'> & {
	content: ModelMessage['content'] | SerializedImagePart[];
};

function reviveImageUrls(messages: SerializedModelMessage[]): ModelMessage[] {
	return messages.map((message) => {
		if (message.role !== 'user' || !Array.isArray(message.content)) {
			// SAFETY: non-user or non-array content is already a ModelMessage shape from parseJson.
			return message as ModelMessage;
		}
		const content = message.content.map((part) =>
			part.type === 'image' && isJsonString(part.image)
				? { ...part, image: new URL(part.image) }
				: part
		);
		// SAFETY: replacing image strings with URL objects keeps the user-message ModelMessage contract.
		return { ...message, content } as ModelMessage;
	});
}
