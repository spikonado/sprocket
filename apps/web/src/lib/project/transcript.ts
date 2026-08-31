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

function toolResultPart(part: LocalTranscriptPart): AssistantPart {
	return {
		type: 'tool-result',
		callId: part.tool?.callId ?? `tool:${part.number}`,
		name: part.tool?.name ?? 'tool',
		output: part.tool?.output ?? null
	};
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

	const flushResponse = () => {
		if (pendingResponse) {
			messages.push(pendingResponse);
			pendingResponse = null;
		}
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
			if (pendingResponse && pendingResponse.runId === part.runId) {
				pendingResponse.parts = [...pendingResponse.parts, ...items];
				pendingResponse.text += text;
				continue;
			}
			flushResponse();
			pendingResponse = {
				_id: responseMessageId(part.runId),
				_creationTime: part.number,
				threadId: args.threadId,
				runId: part.runId,
				userId: args.userId,
				type: 'response',
				text,
				attachments: [],
				parts: items,
				runStatus: 'completed',
				runStartedAt: part.number
			};
			continue;
		}
		if (part.kind === 'tool') {
			const toolPart = toolResultPart(part);
			if (pendingResponse && pendingResponse.runId === part.runId) {
				pendingResponse.parts = [...pendingResponse.parts, toolPart];
			} else {
				const last = messages.at(-1);
				if (last?.type === 'response' && last.runId === part.runId) {
					last.parts = [...last.parts, toolPart];
				} else {
					flushResponse();
					pendingResponse = {
						_id: responseMessageId(part.runId),
						_creationTime: part.number,
						threadId: args.threadId,
						runId: part.runId,
						userId: args.userId,
						type: 'response',
						text: '',
						attachments: [],
						parts: [toolPart],
						runStatus: 'completed',
						runStartedAt: part.number
					};
				}
			}
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
			if (part.type === 'tool-result') {
				const callId = toolCallId(part);
				return callId !== undefined && !liveCallIds.has(callId);
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
