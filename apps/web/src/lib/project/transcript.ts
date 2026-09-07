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

function pickRicherPart(current: AssistantPart, incoming: AssistantPart): AssistantPart {
	if (current.type === 'reasoning' && incoming.type === 'reasoning') {
		return !current.text && incoming.text ? incoming : current;
	}
	if (current.type === 'tool-call' && incoming.type === 'tool-call') {
		const merged = {
			...current,
			...incoming,
			input: current.input == null ? incoming.input : current.input
		};
		const startedAt = current.startedAt ?? incoming.startedAt;
		const completedAt = current.completedAt ?? incoming.completedAt;
		if (startedAt !== undefined) merged.startedAt = startedAt;
		if (completedAt !== undefined) merged.completedAt = completedAt;
		return merged;
	}
	if (current.type === 'tool-result' && incoming.type === 'tool-result') {
		if (isJsonObject(current.output) && isJsonObject(incoming.output)) {
			return { ...incoming, output: { ...incoming.output, ...current.output } };
		}
		return incoming.output != null ? incoming : current;
	}
	if (current.type === 'text' && incoming.type === 'text') {
		return incoming.text.length >= current.text.length ? incoming : current;
	}
	return incoming;
}

function mergeSourceNumbers(left?: number[], right?: number[]): number[] | undefined {
	if (!left && !right) return undefined;
	return [...new Set([...(left ?? []), ...(right ?? [])])].sort((a, b) => a - b);
}

function mergeStreamIds(left?: string[], right?: string[]): string[] | undefined {
	if (!left && !right) return undefined;
	const seen = new Set<string>();
	const ids: string[] = [];
	for (const id of [...(left ?? []), ...(right ?? [])]) {
		if (seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
	}
	return ids;
}

function mergeSameIdMessages(current: ThreadMessage, incoming: ThreadMessage): ThreadMessage {
	const currentStart = current.sourceNumbers?.[0] ?? 0;
	const incomingStart = incoming.sourceNumbers?.[0] ?? 0;
	const earlier = currentStart <= incomingStart ? current : incoming;
	const later = currentStart <= incomingStart ? incoming : current;
	const used = new Set<string>();
	const parts: AssistantPart[] = [];
	for (const part of earlier.parts) {
		const key = partKey(part);
		used.add(key);
		const other = later.parts.find((item) => partKey(item) === key);
		parts.push(other ? pickRicherPart(part, other) : part);
	}
	for (const part of later.parts) {
		const key = partKey(part);
		if (used.has(key)) continue;
		parts.push(part);
	}
	const merged: ThreadMessage = {
		...earlier,
		text: joinAssistantTextParts(parts),
		parts,
		runStatus: later.runStatus,
		sourceNumbers: mergeSourceNumbers(current.sourceNumbers, incoming.sourceNumbers),
		streamIds: mergeStreamIds(current.streamIds, incoming.streamIds)
	};
	if (current.detailsLoaded === true && incoming.detailsLoaded === true) {
		merged.detailsLoaded = true;
	} else if (current.detailsLoaded !== undefined || incoming.detailsLoaded !== undefined) {
		merged.detailsLoaded = false;
	}
	if (later.runCompletedAt !== undefined) merged.runCompletedAt = later.runCompletedAt;
	else if (earlier.runCompletedAt !== undefined) merged.runCompletedAt = earlier.runCompletedAt;
	return merged;
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
			continue;
		}
		byId.set(message._id, mergeSameIdMessages(current, message));
	}
	return [...byId.values()].sort(
		(left, right) => (left.sourceNumbers?.[0] ?? 0) - (right.sourceNumbers?.[0] ?? 0)
	);
}
