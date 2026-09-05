import type { Id } from '$convex/_generated/dataModel';
import { joinAssistantTextParts, type AssistantPart } from '$convex/lib/assistantParts';
import type { LiveCompletionOverlay, ThreadMessage } from '$lib/types/sprocket';

function responseMessageId(runId: ThreadMessage['runId']): string {
	return `response:${runId}`;
}

function toolCallId(part: AssistantPart): string | undefined {
	if (part.type === 'tool-call' || part.type === 'tool-result') {
		return part.callId;
	}
	return undefined;
}

function historyHasLiveCompletion(
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
			(!live.streamId || message.streamIds?.includes(live.streamId))
	);
}

export function mergePagedTranscriptWithLive(args: {
	messages: ThreadMessage[];
	live: LiveCompletionOverlay | null;
	userId: string;
	threadId: Id<'threadRecords'>;
	attachmentUrls?: Map<string, string>;
}): ThreadMessage[] {
	const messages = args.messages.map((message) => ({ ...message, parts: [...message.parts] }));
	const live = args.live?.threadId === args.threadId ? args.live : null;
	if (live && !historyHasLiveCompletion(args.messages, live)) {
		const existingIndex = messages.findIndex(
			(message) => message.type === 'response' && message.runId === live.runId
		);
		const existing = existingIndex >= 0 ? messages[existingIndex] : undefined;
		const liveCallIds = new Set(
			live.parts.flatMap((part) => {
				const callId = toolCallId(part);
				return callId ? [callId] : [];
			})
		);
		const kept = (existing?.parts ?? []).filter((part) => {
			const callId = toolCallId(part);
			if (part.type === 'tool-call' && callId !== undefined && liveCallIds.has(callId)) {
				return false;
			}
			if (part.type === 'tool-result') {
				return true;
			}
			if (!live.streamId) {
				return false;
			}
			return !('turnId' in part && part.turnId === live.streamId);
		});
		const parts = [...kept, ...live.parts];
		const overlay: ThreadMessage = {
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

export function mergeTranscriptMessages(existing: ThreadMessage[], incoming: ThreadMessage[]) {
	const byId = new Map(existing.map((message) => [message._id, message]));
	for (const message of incoming) {
		const current = byId.get(message._id);
		if (!current || message.type === 'prompt') {
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
			if (message.detailsLoaded || !current.detailsLoaded) byId.set(message._id, message);
			continue;
		}
		if (currentContainsIncoming) continue;
		if (incomingContainsCurrent) {
			byId.set(message._id, message);
		}
	}
	return [...byId.values()].sort(
		(left, right) => (left.sourceNumbers?.[0] ?? 0) - (right.sourceNumbers?.[0] ?? 0)
	);
}
