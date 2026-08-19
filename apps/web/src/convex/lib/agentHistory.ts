import type { Doc, Id } from '@convex/_generated/dataModel';
import type { ThreadTranscriptMessage } from '@convex/lib/threadTranscript';
import type { AgentHistoryMessage } from '@convex/lib/validators';
import { isRunFinalStatus } from '@convex/lib/validators';
import {
	ensureAssistantToolPartsFromJobs,
	toPersistableExecutorToolJobs,
	type AssistantPart,
	type PersistableExecutorToolJob
} from '@convex/lib/assistantParts';

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
			...(partTurnId !== undefined ? { id: partTurnId } : {}),
			assistant: [],
			results: [],
			hasOpenAiReasoningReference: false
		};

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
			turn.assistant.push({
				type: 'text',
				text: part.text,
				...(providerMetadata !== undefined
					? { additionalParamsJson: JSON.stringify(providerMetadata) }
					: {})
			});
			continue;
		}

		if (part.type === 'reasoning') {
			const providerMetadata = providerMetadataForReplay(
				part.providerMetadata,
				args.stripProviderItemReferences
			);
			const openai = openAiMetadata(providerMetadata);
			const itemId = typeof openai?.itemId === 'string' ? openai.itemId : undefined;
			const blocks: unknown[] = [];
			if (part.text.length > 0) {
				blocks.push({ type: 'text', content: { text: part.text } });
			}
			if (typeof openai?.reasoningEncryptedContent === 'string') {
				blocks.push({ type: 'encrypted', content: openai.reasoningEncryptedContent });
			}
			if (blocks.length > 0 || itemId !== undefined) {
				turn.assistant.push({
					type: 'reasoning',
					...(itemId !== undefined ? { id: itemId } : {}),
					blocksJson: JSON.stringify(blocks)
				});
				if (itemId?.startsWith('rs_')) turn.hasOpenAiReasoningReference = true;
			}
			continue;
		}

		if (part.type === 'tool-call') {
			const providerMetadata = providerMetadataForReplay(
				part.providerMetadata,
				args.stripProviderItemReferences || !turn.hasOpenAiReasoningReference
			);
			turn.assistant.push({
				type: 'toolCall',
				id: part.callId,
				callId: part.callId,
				name: part.name,
				argumentsJson: JSON.stringify(part.input),
				...(providerMetadata !== undefined
					? { additionalParamsJson: JSON.stringify(providerMetadata) }
					: {})
			});
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
	message: ThreadTranscriptMessage;
	jobs: Doc<'executorJobs'>[];
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
	value: unknown,
	stripProviderItemReferences: boolean | undefined
): unknown | undefined {
	if (!stripProviderItemReferences || !value || typeof value !== 'object') {
		return value;
	}
	if (Array.isArray(value)) return value;

	const metadata = value as Record<string, unknown>;
	const openai = openAiMetadata(metadata);
	if (!openai || !Object.hasOwn(openai, 'itemId')) return value;

	const replayableOpenAi = { ...openai };
	delete replayableOpenAi.itemId;
	const replayableMetadata = { ...metadata };
	if (Object.keys(replayableOpenAi).length > 0) {
		replayableMetadata.openai = replayableOpenAi;
	} else {
		delete replayableMetadata.openai;
	}
	return Object.keys(replayableMetadata).length > 0 ? replayableMetadata : undefined;
}

function openAiMetadata(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const openai = (value as Record<string, unknown>).openai;
	return openai && typeof openai === 'object' && !Array.isArray(openai)
		? (openai as Record<string, unknown>)
		: undefined;
}

export function buildCanonicalAgentHistory(args: {
	messages: ThreadTranscriptMessage[];
	jobs: Doc<'executorJobs'>[];
}): AgentHistoryMessage[] {
	const jobsByRunId = new Map<Id<'runs'>, Doc<'executorJobs'>[]>();
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
