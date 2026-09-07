import type { Id } from '@convex/_generated/dataModel';
import { isJsonObject, type JsonObject, type JsonValue } from '@convex/lib/json';
import type {
	AssistantPart,
	AssistantReasoningPart,
	AssistantTextPart,
	AssistantToolCallPart,
	AssistantToolResultPart
} from '@convex/lib/assistantParts';
import type {
	TranscriptCompletionBody,
	TranscriptPromptBody,
	TranscriptToolBody,
	vRunStatus
} from '@convex/lib/validators';
import type { Infer } from 'convex/values';

export type HostedMessageAttachment = {
	imageUploadId: Id<'imageUploads'>;
	name: string;
	mediaType: string;
	size: number;
	url: string | null;
};

export type HostedTranscriptMessage = {
	_id: string;
	_creationTime?: number;
	threadId: Id<'threadRecords'>;
	runId: Id<'runs'>;
	userId: string;
	type: 'prompt' | 'response';
	text: string;
	attachments: HostedMessageAttachment[];
	parts: AssistantPart[];
	runStatus: Infer<typeof vRunStatus>;
	runStartedAt: number;
	runCompletedAt?: number;
	sourceNumbers?: number[];
	streamIds?: string[];
	detailsLoaded?: boolean;
};

/** Matches sprocket-agent TRANSCRIPT_CHUNK_SIZE / local getParts cap. */
export const HOSTED_TRANSCRIPT_CHUNK_SIZE = 100;
// Individual transcript documents can approach Convex's 1 MiB document limit.
export const HOSTED_TRANSCRIPT_DETAIL_CHUNK_SIZE = 8;
/** Matches sprocket-agent TRANSCRIPT_PAGE_SIZE. */
export const HOSTED_TRANSCRIPT_PAGE_SIZE = 40;
/** Projected when no real run start timestamp exists. Never a sequence number. */
export const UNKNOWN_RUN_STARTED_AT = 0;

const TOOL_OUTPUT_SUMMARY_KEYS = new Set([
	'status',
	'error',
	'sessionId',
	'running',
	'command',
	'exitCode',
	'mandateId',
	'approvalUrl'
]);

export type ProjectableTranscriptPart = {
	number: number;
	kind: 'prompt' | 'completion' | 'tool';
	runId: Id<'runs'>;
	createdAt?: number;
	prompt?: TranscriptPromptBody;
	completion?: TranscriptCompletionBody;
	tool?: TranscriptToolBody;
};

export function messagePageStart(
	parts: readonly Pick<ProjectableTranscriptPart, 'number' | 'kind' | 'runId'>[],
	messageLimit: number,
	reachedHistoryStart: boolean
): number | undefined {
	const ordered = [...parts].sort((left, right) => left.number - right.number);
	let currentKey: string | undefined;
	let currentStart: number | undefined;
	let completed = 0;
	const limit = Math.max(1, messageLimit);

	for (let index = ordered.length - 1; index >= 0; index -= 1) {
		const part = ordered[index];
		if (!part) continue;
		const key = part.kind === 'prompt' ? `prompt:${part.runId}` : `response:${part.runId}`;
		if (currentKey === undefined) {
			currentKey = key;
			currentStart = part.number;
			continue;
		}
		if (currentKey === key) {
			currentStart = part.number;
			continue;
		}
		completed += 1;
		if (completed >= limit) {
			return currentStart;
		}
		currentKey = key;
		currentStart = part.number;
	}

	if (reachedHistoryStart && currentKey !== undefined) {
		return currentStart ?? 0;
	}
	return undefined;
}

function promptMessageId(runId: Id<'runs'>): string {
	return `prompt:${runId}`;
}

function responseMessageId(runId: Id<'runs'>): string {
	return `response:${runId}`;
}

function partCallId(part: AssistantPart): string | undefined {
	return part.type === 'tool-call' || part.type === 'tool-result' ? part.callId : undefined;
}

function copyMissingTiming(
	target: AssistantToolCallPart,
	source: AssistantPart
): AssistantToolCallPart {
	const next: AssistantToolCallPart = { ...target };
	if (next.startedAt === undefined && source.type === 'tool-call' && source.startedAt != null) {
		next.startedAt = source.startedAt;
	}
	if (next.completedAt === undefined && source.type === 'tool-call' && source.completedAt != null) {
		next.completedAt = source.completedAt;
	}
	return next;
}

function toolOutputSummary(output: JsonValue): JsonValue {
	if (!isJsonObject(output)) {
		return null;
	}
	const summary: JsonObject = {};
	for (const [key, value] of Object.entries(output)) {
		if (TOOL_OUTPUT_SUMMARY_KEYS.has(key)) {
			summary[key] = value;
		}
	}
	return summary;
}

function omitNullTiming<T extends { startedAt?: number | null; completedAt?: number | null }>(
	part: T
): T {
	const next = { ...part };
	if (next.startedAt == null) {
		delete next.startedAt;
	}
	if (next.completedAt == null) {
		delete next.completedAt;
	}
	return next;
}

function projectTextPart(item: AssistantTextPart): AssistantTextPart {
	const next: AssistantTextPart = {
		type: 'text',
		id: item.id,
		text: item.text
	};
	if (item.turnId !== undefined) next.turnId = item.turnId;
	if (item.startedAt != null) next.startedAt = item.startedAt;
	if (item.completedAt != null) next.completedAt = item.completedAt;
	return next;
}

function projectReasoningPart(
	item: AssistantReasoningPart,
	includeDetails: boolean
): AssistantReasoningPart | undefined {
	if (item.text.trim().length === 0) {
		return undefined;
	}
	const next: AssistantReasoningPart = {
		type: 'reasoning',
		id: item.id,
		text: includeDetails ? item.text : ''
	};
	if (item.turnId !== undefined) next.turnId = item.turnId;
	if (item.startedAt != null) next.startedAt = item.startedAt;
	if (item.completedAt != null) next.completedAt = item.completedAt;
	return next;
}

function projectToolCallPart(
	item: AssistantToolCallPart,
	includeDetails: boolean,
	placeholder: AssistantPart | undefined
): AssistantToolCallPart {
	const next: AssistantToolCallPart = {
		type: 'tool-call',
		callId: item.callId,
		name: item.name,
		input: includeDetails ? item.input : null
	};
	if (item.partId !== undefined) next.partId = item.partId;
	if (item.turnId !== undefined) next.turnId = item.turnId;
	if (item.startedAt != null) next.startedAt = item.startedAt;
	if (item.completedAt != null) next.completedAt = item.completedAt;
	return placeholder ? copyMissingTiming(next, placeholder) : next;
}

function projectCompletionItem(
	item: TranscriptCompletionBody['items'][number],
	includeDetails: boolean,
	placeholder: AssistantPart | undefined
): AssistantPart | undefined {
	const stripped = omitNullTiming(item);
	if (stripped.type === 'text') {
		return projectTextPart(stripped);
	}
	if (stripped.type === 'reasoning') {
		return projectReasoningPart(stripped, includeDetails);
	}
	return projectToolCallPart(stripped, includeDetails, placeholder);
}

function promptAttachments(prompt: TranscriptPromptBody): HostedMessageAttachment[] {
	return prompt.imageUploads.map((upload) => ({
		imageUploadId: upload.imageUploadId,
		name: upload.name,
		mediaType: upload.mediaType,
		size: upload.size,
		url: upload.url ?? null
	}));
}

function emptyResponse(
	userId: string,
	threadId: Id<'threadRecords'>,
	runId: Id<'runs'>,
	includeDetails: boolean
): HostedTranscriptMessage {
	return {
		_id: responseMessageId(runId),
		threadId,
		runId,
		userId,
		type: 'response',
		text: '',
		attachments: [],
		parts: [],
		runStatus: 'completed',
		runStartedAt: UNKNOWN_RUN_STARTED_AT,
		sourceNumbers: [],
		streamIds: [],
		detailsLoaded: includeDetails
	};
}

function toolCallPlaceholder(
	callId: string,
	name: string,
	includeDetails: boolean,
	startedAt: number | undefined
): AssistantToolCallPart {
	const call: AssistantToolCallPart = {
		type: 'tool-call',
		callId,
		name,
		input: includeDetails ? {} : null
	};
	if (startedAt !== undefined) call.startedAt = startedAt;
	return call;
}

function toolResultPart(
	tool: TranscriptToolBody,
	includeDetails: boolean,
	completedAt: number | undefined
): AssistantToolResultPart {
	const output = tool.output === undefined ? null : tool.output;
	const result: AssistantToolResultPart = {
		type: 'tool-result',
		callId: tool.callId,
		name: tool.name,
		output: includeDetails ? output : toolOutputSummary(output)
	};
	if (completedAt !== undefined) result.completedAt = completedAt;
	return result;
}

export function projectTranscriptMessages(args: {
	userId: string;
	threadId: Id<'threadRecords'>;
	parts: readonly ProjectableTranscriptPart[];
	includeDetails: boolean;
}): HostedTranscriptMessage[] {
	const ordered = [...args.parts].sort((left, right) => left.number - right.number);
	const messages: HostedTranscriptMessage[] = [];
	const appliedTerminalTools = new Set<string>();

	for (const part of ordered) {
		if (part.kind === 'prompt') {
			if (!part.prompt) continue;
			messages.push({
				_id: promptMessageId(part.runId),
				_creationTime: UNKNOWN_RUN_STARTED_AT,
				threadId: args.threadId,
				runId: part.runId,
				userId: args.userId,
				type: 'prompt',
				text: part.prompt.text,
				attachments: promptAttachments(part.prompt),
				parts: [],
				runStatus: 'completed',
				runStartedAt: UNKNOWN_RUN_STARTED_AT,
				sourceNumbers: [part.number],
				streamIds: [],
				detailsLoaded: true
			});
			continue;
		}

		const responseId = responseMessageId(part.runId);
		let response = messages.at(-1);
		if (!response || response._id !== responseId) {
			response = emptyResponse(args.userId, args.threadId, part.runId, args.includeDetails);
			messages.push(response);
		}
		response.sourceNumbers = [...(response.sourceNumbers ?? []), part.number];

		if (part.completion) {
			if (part.completion.streamId) {
				response.streamIds = [...(response.streamIds ?? []), part.completion.streamId];
			}
			const callIds = new Set(
				part.completion.items.flatMap((item) => (item.type === 'tool-call' ? [item.callId] : []))
			);
			const results = new Map<string, AssistantPart>();
			const placeholderCalls = new Map<string, AssistantPart>();
			response.parts = response.parts.filter((item) => {
				const callId = partCallId(item);
				if (!callId || !callIds.has(callId)) {
					return true;
				}
				if (item.type === 'tool-call') {
					placeholderCalls.set(callId, item);
					return false;
				}
				if (item.type === 'tool-result') {
					results.set(callId, item);
					return false;
				}
				return true;
			});
			for (const item of part.completion.items) {
				const projected = projectCompletionItem(
					item,
					args.includeDetails,
					item.type === 'tool-call' ? placeholderCalls.get(item.callId) : undefined
				);
				if (!projected) continue;
				if (projected.type === 'text') {
					response.text += projected.text;
				}
				response.parts.push(projected);
				const resultCallId = partCallId(projected);
				if (resultCallId) {
					const result = results.get(resultCallId);
					if (result) {
						results.delete(resultCallId);
						response.parts.push(result);
					}
				}
			}
		}

		if (part.tool) {
			const startedAt = part.tool.status === 'started' ? part.createdAt : undefined;
			const existingCall = response.parts.find(
				(item): item is AssistantToolCallPart =>
					item.type === 'tool-call' && item.callId === part.tool?.callId
			);
			if (existingCall) {
				if (existingCall.startedAt === undefined && startedAt !== undefined) {
					existingCall.startedAt = startedAt;
				}
			} else {
				response.parts.push(
					toolCallPlaceholder(part.tool.callId, part.tool.name, args.includeDetails, startedAt)
				);
			}
			const terminalKey = part.tool.toolInvocationId ?? part.tool.jobId ?? part.tool.callId;
			if (part.tool.status !== 'started' && appliedTerminalTools.add(terminalKey)) {
				const result = toolResultPart(part.tool, args.includeDetails, part.createdAt);
				const resultIndex = response.parts.findIndex(
					(item) => item.type === 'tool-result' && item.callId === part.tool?.callId
				);
				if (resultIndex >= 0) {
					response.parts[resultIndex] = result;
				} else {
					const callIndex = response.parts.findIndex(
						(item) => item.type === 'tool-call' && item.callId === part.tool?.callId
					);
					if (callIndex >= 0) {
						response.parts.splice(callIndex + 1, 0, result);
					} else {
						response.parts.push(result);
					}
				}
			}
		}
	}

	return messages;
}

export function projectablePartFromDoc(part: {
	number: number;
	kind: 'prompt' | 'completion' | 'tool';
	runId: Id<'runs'>;
	_creationTime: number;
	prompt?: TranscriptPromptBody;
	completion?: TranscriptCompletionBody;
	tool?: TranscriptToolBody;
}): ProjectableTranscriptPart {
	const projected: ProjectableTranscriptPart = {
		number: part.number,
		kind: part.kind,
		runId: part.runId,
		createdAt: Math.trunc(part._creationTime)
	};
	if (part.prompt) projected.prompt = part.prompt;
	if (part.completion) projected.completion = part.completion;
	if (part.tool) projected.tool = part.tool;
	return projected;
}
