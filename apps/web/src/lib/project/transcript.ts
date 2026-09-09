import type { Id } from '$convex/_generated/dataModel';
import { joinAssistantTextParts, type AssistantPart } from '$convex/lib/assistantParts';
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
		const liveKeys = new Set(live.parts.map(partKey));
		const liveCallIds = new Set(
			live.parts.flatMap((part) => (part.type === 'tool-call' ? [part.callId] : []))
		);
		const results = new Map<string, AssistantPart>();
		const parts: AssistantPart[] = [];
		let insertionIndex: number | undefined;
		// Early durable tool events must not override the streamed turn's item order.
		for (const part of existing?.parts ?? []) {
			if (part.type === 'tool-result' && liveCallIds.has(part.callId)) {
				results.set(part.callId, part);
				insertionIndex ??= parts.length;
			} else if (liveKeys.has(partKey(part))) {
				insertionIndex ??= parts.length;
			} else {
				parts.push(part);
			}
		}
		const previousParts = new Map(existing?.parts.map((part) => [partKey(part), part]));
		const turnParts = live.parts.flatMap((incoming) => {
			const previous = previousParts.get(partKey(incoming));
			const part =
				previous?.type === 'tool-call' && incoming.type === 'tool-call'
					? { ...incoming, startedAt: incoming.startedAt ?? previous.startedAt }
					: incoming;
			const result = part.type === 'tool-call' ? results.get(part.callId) : undefined;
			return result && !liveKeys.has(partKey(result)) ? [part, result] : [part];
		});
		parts.splice(insertionIndex ?? parts.length, 0, ...turnParts);
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
