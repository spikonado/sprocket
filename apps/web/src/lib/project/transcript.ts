import type { Id } from '$convex/_generated/dataModel';
import { joinAssistantTextParts, type AssistantPart } from '$convex/lib/assistantParts';
import type {
	LiveCompletionOverlay,
	LocalTranscriptPart,
	MessageAttachment,
	ThreadMessage
} from '$lib/types/sprocket';

function promptMessageId(runId: Id<'runs'>): Id<'threadMessages'> {
	// SAFETY: local replica rows are not Convex threadMessages documents.
	return `prompt:${runId}` as Id<'threadMessages'>;
}

function responseMessageId(runId: Id<'runs'>): Id<'threadMessages'> {
	// SAFETY: local replica rows are not Convex threadMessages documents.
	return `response:${runId}` as Id<'threadMessages'>;
}

function toolCallId(part: AssistantPart): string | undefined {
	if (part.type === 'tool-call' || part.type === 'tool-result') {
		return part.callId;
	}
	return undefined;
}

function toolProgressKey(tool: NonNullable<LocalTranscriptPart['tool']>): string {
	return tool.toolInvocationId ?? tool.jobId ?? tool.callId;
}

function isTerminalToolStatus(
	status: NonNullable<LocalTranscriptPart['tool']>['status']
): boolean {
	return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function toolResultPart(part: LocalTranscriptPart): Extract<AssistantPart, { type: 'tool-result' }> {
	const result: Extract<AssistantPart, { type: 'tool-result' }> = {
		type: 'tool-result',
		callId: part.tool?.callId ?? `tool:${part.number}`,
		name: part.tool?.name ?? 'tool',
		output: part.tool?.output ?? null
	};
	return result;
}

function applyCompletionItems(parts: AssistantPart[], items: AssistantPart[]): AssistantPart[] {
	const next = [...parts];
	for (const item of items) {
		if (item.type !== 'tool-call') {
			next.push(item);
			continue;
		}
		const existingIndex = next.findIndex(
			(part) => part.type === 'tool-call' && part.callId === item.callId
		);
		if (existingIndex >= 0) {
			next[existingIndex] = item;
			continue;
		}
		next.push(item);
	}
	return next;
}

function applyToolProgress(
	parts: AssistantPart[],
	part: LocalTranscriptPart,
	appliedTerminalKeys: Set<string>
): AssistantPart[] {
	const tool = part.tool;
	if (!tool) {
		return parts;
	}
	const callId = tool.callId;
	const key = toolProgressKey(tool);
	const next = [...parts];
	const callIndex = next.findIndex((entry) => entry.type === 'tool-call' && entry.callId === callId);
	if (callIndex < 0) {
		next.push({
			type: 'tool-call',
			callId,
			name: tool.name,
			input: {}
		});
	}
	if (tool.status === 'started') {
		return next;
	}
	if (!isTerminalToolStatus(tool.status) || appliedTerminalKeys.has(key)) {
		return next;
	}
	appliedTerminalKeys.add(key);
	const result = toolResultPart(part);
	const resultIndex = next.findIndex(
		(entry) => entry.type === 'tool-result' && entry.callId === callId
	);
	if (resultIndex >= 0) {
		next[resultIndex] = result;
		return next;
	}
	const insertAt = next.findIndex((entry) => entry.type === 'tool-call' && entry.callId === callId);
	if (insertAt >= 0) {
		next.splice(insertAt + 1, 0, result);
		return next;
	}
	next.push(result);
	return next;
}

function promptAttachments(
	part: LocalTranscriptPart,
	attachmentUrls: Map<string, string>
): MessageAttachment[] {
	return (part.prompt?.imageUploads ?? []).map((upload) => ({
		imageUploadId: upload.imageUploadId,
		name: upload.name,
		mediaType: upload.mediaType,
		size: upload.size,
		url: attachmentUrls.get(upload.imageUploadId) ?? upload.url ?? null
	}));
}

export function messagesFromTranscriptParts(args: {
	parts: LocalTranscriptPart[];
	userId: string;
	threadId: Id<'threadRecords'>;
	attachmentUrls?: Map<string, string>;
}): ThreadMessage[] {
	const attachmentUrls = args.attachmentUrls ?? new Map();
	const ordered = [...args.parts].sort((left, right) => left.number - right.number);
	const messages: ThreadMessage[] = [];
	let pendingResponse: ThreadMessage | null = null;
	const appliedTerminalKeys = new Set<string>();

	const flushResponse = () => {
		if (pendingResponse) {
			messages.push(pendingResponse);
			pendingResponse = null;
		}
	};

	const responseForRun = (runId: Id<'runs'>, creationTime: number): ThreadMessage => {
		if (pendingResponse && pendingResponse.runId === runId) {
			return pendingResponse;
		}
		const last = messages.at(-1);
		if (last?.type === 'response' && last.runId === runId) {
			messages.pop();
			pendingResponse = last;
			return last;
		}
		flushResponse();
		pendingResponse = {
			_id: responseMessageId(runId),
			_creationTime: creationTime,
			threadId: args.threadId,
			runId,
			userId: args.userId,
			type: 'response',
			text: '',
			attachments: [],
			parts: [],
			runStatus: 'completed',
			runStartedAt: creationTime
		};
		return pendingResponse;
	};

	for (const part of ordered) {
		if (part.kind === 'prompt') {
			flushResponse();
			messages.push({
				_id: promptMessageId(part.runId),
				_creationTime: part.number,
				threadId: args.threadId,
				runId: part.runId,
				userId: args.userId,
				type: 'prompt',
				text: part.prompt?.text ?? '',
				attachments: promptAttachments(part, attachmentUrls),
				parts: [],
				runStatus: 'completed',
				runStartedAt: part.number
			});
			continue;
		}
		if (part.kind === 'completion') {
			const items = part.completion?.items ?? [];
			const text = items
				.filter((item): item is Extract<AssistantPart, { type: 'text' }> => item.type === 'text')
				.map((item) => item.text)
				.join('');
			const response = responseForRun(part.runId, part.number);
			response.parts = applyCompletionItems(response.parts, items);
			response.text += text;
			continue;
		}
		if (part.kind === 'tool') {
			const response = responseForRun(part.runId, part.number);
			response.parts = applyToolProgress(response.parts, part, appliedTerminalKeys);
		}
	}
	flushResponse();
	return messages;
}

function historyHasLiveCompletion(
	parts: LocalTranscriptPart[],
	live: LiveCompletionOverlay | null
): boolean {
	if (!live) {
		return false;
	}
	return parts.some((part) => {
		if (part.kind !== 'completion' || part.runId !== live.runId) {
			return false;
		}
		if (live.streamId && part.completion?.streamId) {
			return part.completion.streamId === live.streamId;
		}
		return true;
	});
}

export function mergePagedTranscriptWithLive(args: {
	parts: LocalTranscriptPart[];
	live: LiveCompletionOverlay | null;
	userId: string;
	threadId: Id<'threadRecords'>;
	attachmentUrls?: Map<string, string>;
}): ThreadMessage[] {
	const messages = messagesFromTranscriptParts({
		parts: args.parts,
		userId: args.userId,
		threadId: args.threadId,
		attachmentUrls: args.attachmentUrls
	});
	const live = args.live?.threadId === args.threadId ? args.live : null;
	if (live && !historyHasLiveCompletion(args.parts, live)) {
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

export function mergeTranscriptParts(
	existing: LocalTranscriptPart[],
	incoming: LocalTranscriptPart[]
): LocalTranscriptPart[] {
	const byNumber = new Map<number, LocalTranscriptPart>();
	for (const part of existing) {
		byNumber.set(part.number, part);
	}
	for (const part of incoming) {
		byNumber.set(part.number, part);
	}
	return [...byNumber.values()].sort((left, right) => left.number - right.number);
}
