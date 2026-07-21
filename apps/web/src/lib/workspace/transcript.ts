import type { ThreadMessage } from '$lib/types/sprocket';

export const VISIBLE_TRANSCRIPT_MESSAGE_LIMIT = 40;

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
