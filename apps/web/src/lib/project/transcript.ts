import type { Id } from '$convex/_generated/dataModel';
import { joinAssistantTextParts, type AssistantPart } from '$convex/lib/assistantParts';
import type {
	LiveCompletionOverlay,
	LocalTranscriptPart,
	MessageAttachment,
	ThreadMessage
} from '$lib/types/sprocket';
import type { Infer } from 'convex/values';
import { vRunStatus } from '$convex/lib/validators';

function messageTypeRank(message: ThreadMessage): number {
	return message.type === 'prompt' ? 0 : 1;
}

function compareMessagesByOrder(left: ThreadMessage, right: ThreadMessage): number {
	// Latest-run messages carry their wall-clock startedAt as their order so they
	// always sort after the other runs' transcript parts. Within a run the
	// prompt and its response share that value, so the type rank keeps the
	// prompt above the response.
	if (left.order !== right.order) {
		if (left.order === undefined) {
			return 1;
		}
		if (right.order === undefined) {
			return -1;
		}
		return left.order - right.order;
	}
	if (left.runStartedAt !== right.runStartedAt) {
		return left.runStartedAt - right.runStartedAt;
	}
	const leftRank = messageTypeRank(left);
	const rightRank = messageTypeRank(right);
	if (leftRank !== rightRank) {
		return leftRank - rightRank;
	}
	const leftCreated = left._creationTime ?? 0;
	const rightCreated = right._creationTime ?? 0;
	if (leftCreated !== rightCreated) {
		return leftCreated - rightCreated;
	}
	return String(left._id).localeCompare(String(right._id));
}

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
				order: part.number,
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
				order: part.number,
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
						order: part.number,
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

function resolveLiveOverlay(args: {
	threadId: Id<'threadRecords'>;
	live: LiveCompletionOverlay | null;
	latestRun: {
		_id: Id<'runs'>;
		status: Infer<typeof vRunStatus>;
		startedAt: number;
		completedAt?: number;
	} | null;
	liveRestore?: { threadId: Id<'threadRecords'>; overlay: LiveCompletionOverlay | null };
}): LiveCompletionOverlay | null {
	if (args.live) {
		if (args.live.threadId !== args.threadId) {
			// The stream belongs to a different thread; never leak it into this view.
			return null;
		}
		return args.live;
	}
	const restore = args.liveRestore;
	if (!restore || restore.threadId !== args.threadId || !restore.overlay) {
		return null;
	}
	const latestRun = args.latestRun;
	if (!latestRun || latestRun._id === restore.overlay.runId) {
		return restore.overlay;
	}
	return null;
}

export function mergePagedTranscriptWithLive(args: {
	parts: LocalTranscriptPart[];
	live: LiveCompletionOverlay | null;
	liveRestore?: { threadId: Id<'threadRecords'>; overlay: LiveCompletionOverlay | null };
	latestRun: {
		_id: Id<'runs'>;
		status: Infer<typeof vRunStatus>;
		startedAt: number;
		completedAt?: number;
	} | null;
	latestPrompt?: { text: string; imageUploadIds: Id<'imageUploads'>[] };
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
	const latestRun = args.latestRun;
	if (latestRun) {
		for (const message of messages) {
			if (message.runId !== latestRun._id) {
				continue;
			}
			message.runStatus = latestRun.status;
			message.runStartedAt = latestRun.startedAt;
			message.order = latestRun.startedAt;
			if (latestRun.completedAt !== undefined) {
				message.runCompletedAt = latestRun.completedAt;
			}
		}
	}

	if (
		latestRun &&
		args.latestPrompt &&
		!messages.some((message) => message.type === 'prompt' && message.runId === latestRun._id)
	) {
		messages.push({
			_id: promptMessageId(latestRun._id),
			_creationTime: latestRun.startedAt,
			order: latestRun.startedAt,
			threadId: args.threadId,
			runId: latestRun._id,
			userId: args.userId,
			type: 'prompt',
			text: args.latestPrompt.text,
			attachments: args.latestPrompt.imageUploadIds.map((imageUploadId) => ({
				imageUploadId,
				name: 'attachment',
				mediaType: 'application/octet-stream',
				size: 0,
				url: args.attachmentUrls?.get(imageUploadId) ?? null
			})),
			parts: [],
			runStatus: latestRun.status,
			runStartedAt: latestRun.startedAt,
			runCompletedAt: latestRun.completedAt
		});
	}

	const live = resolveLiveOverlay({
		threadId: args.threadId,
		live: args.live,
		latestRun: args.latestRun,
		liveRestore: args.liveRestore
	});
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
			order: live.runStartedAt,
			threadId: args.threadId,
			runId: live.runId,
			userId: args.userId,
			type: 'response',
			text: joinAssistantTextParts(parts),
			attachments: [],
			parts,
			runStatus: latestRun && latestRun._id === live.runId ? latestRun.status : live.runStatus,
			runStartedAt: live.runStartedAt
		};
		if (existingIndex >= 0) {
			messages[existingIndex] = overlay;
		} else {
			messages.push(overlay);
		}
	}

	return messages.sort(compareMessagesByOrder);
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
