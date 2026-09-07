import type { AssistantPart } from '$convex/lib/assistantParts';
import type { LocalTranscriptPart, ThreadMessage } from '$lib/types/sprocket';

function cloneMessage(message: ThreadMessage): ThreadMessage {
	return {
		...message,
		attachments: [...message.attachments],
		parts: [...message.parts],
		sourceNumbers: [...(message.sourceNumbers ?? [])],
		streamIds: [...(message.streamIds ?? [])]
	};
}

function applyCompletion(target: ThreadMessage, incoming: ThreadMessage) {
	const callIds = new Set<string>();
	for (const part of incoming.parts) {
		if (part.type === 'tool-call') callIds.add(part.callId);
	}
	const placeholders = new Map<string, AssistantPart>();
	const results = new Map<string, AssistantPart>();
	const kept: AssistantPart[] = [];
	for (const part of target.parts) {
		if (part.type === 'tool-call' && callIds.has(part.callId)) {
			placeholders.set(part.callId, part);
			continue;
		}
		if (part.type === 'tool-result' && callIds.has(part.callId)) {
			results.set(part.callId, part);
			continue;
		}
		kept.push(part);
	}
	for (const part of incoming.parts) {
		if (part.type === 'tool-result') results.delete(part.callId);
	}
	for (const part of incoming.parts) {
		if (part.type === 'tool-call') {
			const placeholder = placeholders.get(part.callId);
			kept.push(
				placeholder?.type === 'tool-call'
					? {
							...part,
							startedAt: part.startedAt ?? placeholder.startedAt,
							completedAt: part.completedAt ?? placeholder.completedAt
						}
					: part
			);
			const result = results.get(part.callId);
			if (result) {
				results.delete(part.callId);
				kept.push(result);
			}
			continue;
		}
		kept.push(part);
	}
	target.parts = kept;
	target.text += incoming.text;
	target.sourceNumbers = [...(target.sourceNumbers ?? []), ...(incoming.sourceNumbers ?? [])];
	target.streamIds = [...(target.streamIds ?? []), ...(incoming.streamIds ?? [])];
}

function applyTool(target: ThreadMessage, incoming: ThreadMessage, appliedTerminal: Set<string>) {
	for (const part of incoming.parts) {
		if (part.type !== 'tool-call') continue;
		const index = target.parts.findIndex(
			(item) => item.type === 'tool-call' && item.callId === part.callId
		);
		if (index >= 0) {
			const existing = target.parts[index];
			if (existing?.type === 'tool-call' && existing.startedAt == null && part.startedAt != null) {
				target.parts[index] = { ...existing, startedAt: part.startedAt };
			}
		} else {
			target.parts.push(part);
		}
	}
	for (const part of incoming.parts) {
		if (part.type !== 'tool-result') continue;
		if (appliedTerminal.has(part.callId)) continue;
		appliedTerminal.add(part.callId);
		const resultIndex = target.parts.findIndex(
			(item) => item.type === 'tool-result' && item.callId === part.callId
		);
		if (resultIndex >= 0) {
			target.parts[resultIndex] = part;
			continue;
		}
		const callIndex = target.parts.findIndex(
			(item) => item.type === 'tool-call' && item.callId === part.callId
		);
		if (callIndex >= 0) {
			target.parts.splice(callIndex + 1, 0, part);
		} else {
			target.parts.push(part);
		}
	}
	target.sourceNumbers = [...(target.sourceNumbers ?? []), ...(incoming.sourceNumbers ?? [])];
}

function startResponse(kind: LocalTranscriptPart['kind'], message: ThreadMessage) {
	const started = cloneMessage(message);
	const appliedTerminal = new Set<string>();
	if (kind === 'tool') {
		for (const item of started.parts) {
			if (item.type === 'tool-result') appliedTerminal.add(item.callId);
		}
	}
	return { message: started, appliedTerminal };
}

function foldDetails(target: ThreadMessage, incoming: ThreadMessage) {
	target.detailsLoaded = target.detailsLoaded === true && incoming.detailsLoaded === true;
}

export function assembleTranscriptParts(parts: readonly LocalTranscriptPart[]): ThreadMessage[] {
	const byNumber = new Map<number, LocalTranscriptPart>();
	for (const part of parts) byNumber.set(part.number, part);
	const ordered = [...byNumber.values()].sort((left, right) => left.number - right.number);
	const messages: ThreadMessage[] = [];
	let open: ReturnType<typeof startResponse> | undefined;

	const finish = () => {
		if (open) messages.push(open.message);
		open = undefined;
	};

	for (const part of ordered) {
		if (!part.message) continue;
		if (part.kind === 'prompt') {
			finish();
			messages.push(cloneMessage(part.message));
			continue;
		}
		if (open && open.message._id === part.message._id) {
			if (part.kind === 'completion') applyCompletion(open.message, part.message);
			else applyTool(open.message, part.message, open.appliedTerminal);
			foldDetails(open.message, part.message);
			continue;
		}
		finish();
		open = startResponse(part.kind, part.message);
	}
	finish();
	return messages;
}
