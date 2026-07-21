import type { ThreadMessage } from '$lib/types/sprocket';

export const VISIBLE_TRANSCRIPT_MESSAGE_LIMIT = 40;
const EMPTY_TRANSCRIPT_MESSAGES: ThreadMessage[] = [];

function compareMessagesChronologically(left: ThreadMessage, right: ThreadMessage): number {
	if (left.runStartedAt !== right.runStartedAt) {
		return left.runStartedAt - right.runStartedAt;
	}
	const leftCreated = left._creationTime ?? 0;
	const rightCreated = right._creationTime ?? 0;
	if (leftCreated !== rightCreated) {
		return leftCreated - rightCreated;
	}
	if (left.type !== right.type) {
		return left.type === 'prompt' ? -1 : 1;
	}
	return left._id.localeCompare(right._id);
}

/** Drop oldest whole runs until the window fits; never leave a response without its prompt. */
export function truncateTranscriptToNewestRuns(
	messages: ThreadMessage[],
	limit = VISIBLE_TRANSCRIPT_MESSAGE_LIMIT
): ThreadMessage[] {
	if (messages.length <= limit) {
		return messages;
	}

	let start = 0;
	while (messages.length - start > limit) {
		const runId = messages[start]?.runId;
		if (!runId) {
			start += 1;
			continue;
		}
		while (start < messages.length && messages[start]?.runId === runId) {
			start += 1;
		}
	}

	const truncated = messages.slice(start);
	return truncated.length > limit ? truncated.slice(-limit) : truncated;
}

/**
 * Keep departing live messages until history absorbs them so independent
 * subscription updates cannot blank the finishing turn.
 *
 * Stable empty references are required: returning a fresh `[]` from an effect
 * that writes `$state` will infinite-loop under Svelte 5 equality checks.
 */
export function holdLiveMessagesUntilHistoryAbsorbs(args: {
	historyMessages: ThreadMessage[];
	liveMessages: ThreadMessage[];
	heldLiveMessages: ThreadMessage[];
}): ThreadMessage[] {
	if (args.liveMessages.length > 0) {
		return args.liveMessages;
	}
	if (args.heldLiveMessages.length === 0) {
		return args.heldLiveMessages;
	}
	const historyIds = new Set(args.historyMessages.map((message) => message._id));
	if (args.heldLiveMessages.every((message) => historyIds.has(message._id))) {
		return EMPTY_TRANSCRIPT_MESSAGES;
	}
	return args.heldLiveMessages;
}

/** Merge history + live pages; live wins on ID collisions. Keeps the newest visible window. */
export function mergeThreadTranscriptMessages(args: {
	historyMessages: ThreadMessage[] | null | undefined;
	liveMessages: ThreadMessage[] | null | undefined;
}): ThreadMessage[] {
	const byId = new Map<ThreadMessage['_id'], ThreadMessage>();

	for (const message of args.historyMessages ?? []) {
		byId.set(message._id, message);
	}
	for (const message of args.liveMessages ?? []) {
		byId.set(message._id, message);
	}

	return truncateTranscriptToNewestRuns([...byId.values()].sort(compareMessagesChronologically));
}
