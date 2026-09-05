import type { Id } from '$convex/_generated/dataModel';
import { joinAssistantTextParts, type AssistantPart } from '$convex/lib/assistantParts';
import { isJsonObject } from '$convex/lib/json';
import type { LiveCompletionOverlay, ThreadMessage } from '$lib/types/sprocket';

function responseMessageId(runId: ThreadMessage['runId']): string {
	return `response:${runId}`;
}

function partKey(part: AssistantPart): string {
	return part.type === 'tool-call' || part.type === 'tool-result'
		? `${part.type}:${part.callId}`
		: `${part.type}:${part.turnId ?? ''}:${part.id}`;
}

export function historyHasLiveCompletion(
	messages: ThreadMessage[],
	live: LiveCompletionOverlay | null
): boolean {
	if (!live) {
		return false;
	}
	return messages.some(
		(message) =>
			message.type === 'response' &&
			message.runId === live.runId &&
			live.streamId !== undefined &&
			message.streamIds?.includes(live.streamId)
	);
}

export function mergePagedTranscriptWithLive(args: {
	messages: ThreadMessage[];
	live: LiveCompletionOverlay | null;
	pending?: LiveCompletionOverlay[];
	userId: string;
	threadId: Id<'threadRecords'>;
}): ThreadMessage[] {
	const overlays = [...(args.pending ?? []), ...(args.live ? [args.live] : [])].filter(
		(live) => live.threadId === args.threadId && !historyHasLiveCompletion(args.messages, live)
	);
	if (overlays.length === 0) return args.messages;
	const messages = [...args.messages];
	for (const live of overlays) {
		const existingIndex = messages.findIndex(
			(message) => message.type === 'response' && message.runId === live.runId
		);
		const existing = existingIndex >= 0 ? messages[existingIndex] : undefined;
		const parts = [...(existing?.parts ?? [])];
		const indexes = new Map(parts.map((part, index) => [partKey(part), index]));
		for (const part of live.parts) {
			const index = indexes.get(partKey(part));
			if (index === undefined) {
				indexes.set(partKey(part), parts.length);
				parts.push(part);
			} else {
				parts[index] = part;
			}
		}
		const overlay: ThreadMessage = {
			...existing,
			_id: existing?._id ?? responseMessageId(live.runId),
			_creationTime: live.runStartedAt,
			threadId: args.threadId,
			runId: live.runId,
			userId: args.userId,
			type: 'response',
			text: joinAssistantTextParts(parts),
			attachments: [],
			parts,
			runStatus: live.runStatus,
			runStartedAt: live.runStartedAt
		};
		if (existingIndex >= 0) {
			messages[existingIndex] = overlay;
		} else {
			messages.push(overlay);
		}
	}

	return messages;
}

function retainDetails(message: ThreadMessage, detailed: ThreadMessage): ThreadMessage {
	if (message.detailsLoaded) return message;
	const details = new Map(detailed.parts.map((part) => [partKey(part), part]));
	const parts = message.parts.map((part) => {
		const full = details.get(partKey(part));
		if (!full) return part;
		if (part.type === 'reasoning' && full.type === 'reasoning' && !part.text) return full;
		if (part.type === 'tool-call' && full.type === 'tool-call' && part.input == null) return full;
		if (part.type === 'tool-result' && full.type === 'tool-result' && full.output != null) {
			return isJsonObject(part.output) && isJsonObject(full.output)
				? { ...part, output: { ...full.output, ...part.output } }
				: full;
		}
		return part;
	});
	return { ...message, parts };
}

export function mergeTranscriptMessages(existing: ThreadMessage[], incoming: ThreadMessage[]) {
	const byId = new Map(existing.map((message) => [message._id, message]));
	for (const message of incoming) {
		const current = byId.get(message._id);
		if (!current) {
			byId.set(message._id, message);
			continue;
		}
		const currentNumbers = new Set(current.sourceNumbers ?? []);
		const incomingNumbers = new Set(message.sourceNumbers ?? []);
		const currentContainsIncoming = [...incomingNumbers].every((number) =>
			currentNumbers.has(number)
		);
		const incomingContainsCurrent = [...currentNumbers].every((number) =>
			incomingNumbers.has(number)
		);
		if (currentContainsIncoming && incomingContainsCurrent) {
			if (message.detailsLoaded && !current.detailsLoaded) byId.set(message._id, message);
			continue;
		}
		if (currentContainsIncoming) {
			if (message.detailsLoaded) byId.set(message._id, retainDetails(current, message));
			continue;
		}
		if (incomingContainsCurrent) {
			byId.set(message._id, retainDetails(message, current));
		}
	}
	return [...byId.values()].sort(
		(left, right) => (left.sourceNumbers?.[0] ?? 0) - (right.sourceNumbers?.[0] ?? 0)
	);
}
