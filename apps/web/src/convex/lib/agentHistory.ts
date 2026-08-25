import type { ThreadTranscriptMessage } from '@convex/lib/threadTranscript';
import type { AgentHistoryMessage } from '@convex/lib/validators';
import { isRunFinalStatus } from '@convex/lib/validators';
import { isJsonObject, isJsonString, type JsonObject, type JsonValue } from '@convex/lib/json';
import {
	ensureAssistantToolPartsFromJobs,
	toPersistableExecutorToolJobs,
	type AssistantPart,
	type PersistableExecutorToolJob
} from '@convex/lib/assistantParts';

export type CanonicalHistoryMessage =
	| {
			type: 'prompt';
			text: string;
			attachments: Array<{ mediaType: string; url: string }>;
	  }
	| {
			type: 'response';
			runId: string;
			runStatus: ThreadTranscriptMessage['runStatus'];
			text: string;
			parts: AssistantPart[];
	  };

export type CanonicalHistoryJob = Parameters<typeof toPersistableExecutorToolJobs>[0][number] & {
	runId: string;
};

export function buildAgentHistoryFromAssistantParts(args: {
	parts: AssistantPart[];
	jobs: PersistableExecutorToolJob[];
	fallbackText: string;
	stripProviderItemReferences?: boolean;
}): AgentHistoryMessage[] {
	const parts = ensureAssistantToolPartsFromJobs(args.parts, args.jobs);
	const history: AgentHistoryMessage[] = [];
	let turn:
		| {
				id?: string;
				assistant: AgentHistoryMessage['contents'];
				results: AgentHistoryMessage['contents'];
				hasOpenAiReasoningReference: boolean;
		  }
		| undefined;
	let sawAssistantText = false;

	const flushTurn = () => {
		if (!turn) return;
		if (turn.assistant.length > 0) {
			history.push({
				role: 'assistant',
				contents: turn.assistant
			});
		}
		if (turn.results.length > 0) {
			history.push({
				role: 'user',
				contents: turn.results
			});
		}
		turn = undefined;
	};

	for (const part of parts) {
		if (part.type === 'tool-result') {
			turn ??= { assistant: [], results: [], hasOpenAiReasoningReference: false };
			turn.results.push({
				type: 'toolResult',
				id: part.callId,
				callId: part.callId,
				items: [
					{
						type: 'text',
						text: JSON.stringify(part.output)
					}
				]
			});
			continue;
		}

		const partTurnId = part.turnId;
		const startsInferredTurn =
			turn !== undefined &&
			partTurnId === undefined &&
			turn.id === undefined &&
			turn.results.length > 0 &&
			(part.type === 'text' || part.type === 'reasoning' || part.type === 'tool-call');
		if (
			turn &&
			((partTurnId !== undefined && turn.id !== partTurnId) ||
				(partTurnId === undefined && turn.id !== undefined) ||
				startsInferredTurn)
		) {
			flushTurn();
		}
		turn ??= {
			assistant: [],
			results: [],
			hasOpenAiReasoningReference: false
		};
		if (partTurnId !== undefined) turn.id = partTurnId;

		if (part.type === 'text') {
			const text = part.text.trim();
			if (!text) {
				continue;
			}
			sawAssistantText = true;
			const providerMetadata = providerMetadataForReplay(
				part.providerMetadata,
				args.stripProviderItemReferences || !turn.hasOpenAiReasoningReference
			);
			const textContent: Extract<AgentHistoryMessage['contents'][number], { type: 'text' }> = {
				type: 'text',
				text: part.text
			};
			if (providerMetadata !== undefined) {
				textContent.additionalParamsJson = JSON.stringify(providerMetadata);
			}
			turn.assistant.push(textContent);
			continue;
		}

		if (part.type === 'reasoning') {
			const providerMetadata = providerMetadataForReplay(
				part.providerMetadata,
				args.stripProviderItemReferences
			);
			const openai = openAiMetadata(providerMetadata);
			const itemId =
				openai !== undefined && isJsonString(openai.itemId) ? openai.itemId : undefined;
			const blocks: Array<{ type: string; content: string | { text: string } }> = [];
			if (part.text.length > 0) {
				blocks.push({ type: 'text', content: { text: part.text } });
			}
			if (openai !== undefined && isJsonString(openai.reasoningEncryptedContent)) {
				blocks.push({ type: 'encrypted', content: openai.reasoningEncryptedContent });
			}
			if (blocks.length > 0 || itemId !== undefined) {
				const reasoning: Extract<AgentHistoryMessage['contents'][number], { type: 'reasoning' }> = {
					type: 'reasoning',
					blocksJson: JSON.stringify(blocks)
				};
				if (itemId !== undefined) reasoning.id = itemId;
				turn.assistant.push(reasoning);
				if (itemId?.startsWith('rs_')) turn.hasOpenAiReasoningReference = true;
			}
			continue;
		}

		if (part.type === 'tool-call') {
			const providerMetadata = providerMetadataForReplay(
				part.providerMetadata,
				args.stripProviderItemReferences || !turn.hasOpenAiReasoningReference
			);
			const toolCall: Extract<AgentHistoryMessage['contents'][number], { type: 'toolCall' }> = {
				type: 'toolCall',
				id: part.callId,
				callId: part.callId,
				name: part.name,
				argumentsJson: JSON.stringify(part.input)
			};
			if (providerMetadata !== undefined) {
				toolCall.additionalParamsJson = JSON.stringify(providerMetadata);
			}
			turn.assistant.push(toolCall);
			continue;
		}
	}

	flushTurn();
	if (!sawAssistantText && args.fallbackText.trim().length > 0) {
		const lastMessage = history.at(-1);
		if (lastMessage?.role === 'assistant') {
			lastMessage.contents.push({
				type: 'text',
				text: args.fallbackText
			});
		} else {
			history.push({
				role: 'assistant',
				contents: [
					{
						type: 'text',
						text: args.fallbackText
					}
				]
			});
		}
	}

	return history;
}

function buildAgentHistoryFromAssistantMessage(args: {
	message: Extract<CanonicalHistoryMessage, { type: 'response' }>;
	jobs: CanonicalHistoryJob[];
}): AgentHistoryMessage[] {
	const persistedParts = args.message.parts;
	return buildAgentHistoryFromAssistantParts({
		parts: persistedParts,
		jobs: toPersistableExecutorToolJobs(args.jobs),
		fallbackText: args.message.text,
		stripProviderItemReferences: args.message.runStatus !== 'completed'
	});
}

function providerMetadataForReplay(
	value: JsonValue | undefined,
	stripProviderItemReferences: boolean | undefined
): JsonValue | undefined {
	if (!stripProviderItemReferences || !isJsonObject(value)) {
		return value;
	}

	const openai = openAiMetadata(value);
	if (!openai || !Object.hasOwn(openai, 'itemId')) return value;

	const replayableOpenAi = { ...openai };
	delete replayableOpenAi.itemId;
	const replayableMetadata = { ...value };
	if (Object.keys(replayableOpenAi).length > 0) {
		replayableMetadata.openai = replayableOpenAi;
	} else {
		delete replayableMetadata.openai;
	}
	return Object.keys(replayableMetadata).length > 0 ? replayableMetadata : undefined;
}

function openAiMetadata(value: JsonValue | undefined): JsonObject | undefined {
	if (!isJsonObject(value)) return undefined;
	return isJsonObject(value.openai) ? value.openai : undefined;
}

export function buildCanonicalAgentHistory(args: {
	messages: readonly CanonicalHistoryMessage[];
	jobs: readonly CanonicalHistoryJob[];
}): AgentHistoryMessage[] {
	const jobsByRunId = new Map<string, CanonicalHistoryJob[]>();
	for (const job of args.jobs) {
		const runJobs = jobsByRunId.get(job.runId) ?? [];
		runJobs.push(job);
		jobsByRunId.set(job.runId, runJobs);
	}

	const history: AgentHistoryMessage[] = [];
	for (const message of args.messages) {
		if (message.type === 'prompt') {
			const text = message.text.trim();
			const contents: AgentHistoryMessage['contents'] = [
				...(text ? [{ type: 'text' as const, text }] : []),
				...message.attachments.map((attachment) => ({
					type: 'image' as const,
					imageJson: JSON.stringify({
						data: { type: 'url', value: attachment.url },
						media_type: attachment.mediaType.slice('image/'.length)
					})
				}))
			];
			if (contents.length === 0) {
				continue;
			}
			history.push({
				role: 'user',
				contents
			});
			continue;
		}

		if (!isRunFinalStatus(message.runStatus)) {
			continue;
		}

		history.push(
			...buildAgentHistoryFromAssistantMessage({
				message,
				jobs: jobsByRunId.get(message.runId) ?? []
			})
		);
	}

	return history;
}
