import type { ModelMessage } from 'ai';

export type ContextCompaction = {
	summary: string;
	messageCount: number;
};

const COMPACTED_CONTEXT_PREAMBLE =
	'The conversation context was automatically compacted. Treat this summary as authoritative, continue the current task from this state, and do not redo completed work.';

export function contextSummaryText(summary: string): string {
	return `${COMPACTED_CONTEXT_PREAMBLE}\n\n<conversation_summary>\n${summary}\n</conversation_summary>`;
}

export function applyContextCompaction(
	messages: ModelMessage[],
	compaction: ContextCompaction | undefined
): ModelMessage[] {
	if (!compaction) return messages;
	if (compaction.messageCount < 0 || compaction.messageCount > messages.length) {
		throw new Error('Stored context compaction does not match the current conversation.');
	}
	return [
		{
			role: 'user',
			content: contextSummaryText(compaction.summary)
		},
		...messages.slice(compaction.messageCount)
	];
}

export function shouldCompactContext(args: {
	inputTokens: number;
	autoCompactTokenLimit: number;
	messages: ModelMessage[];
}): boolean {
	if (args.inputTokens >= args.autoCompactTokenLimit) return true;
	// Provider usage is available only after a request. This conservative preflight
	// catches a single large prompt or tool result before it can overflow the model.
	const estimatedTokens = estimateContextTokens(args.messages);
	return estimatedTokens >= args.autoCompactTokenLimit;
}

export function estimateContextTokens(messages: ModelMessage[]): number {
	return Math.ceil(JSON.stringify(messages).length / 3);
}

export const CONTEXT_COMPACTION_INSTRUCTIONS = `Summarize the supplied coding-agent conversation so another agent can continue without the original messages.

Preserve:
- every user request and the current objective
- decisions, constraints, plans, and unresolved questions
- files inspected or changed and the important technical details
- tool results, errors, tests, and commands that still matter
- completed work and the exact next steps

Be dense and factual. Do not address the user, continue the task, call tools, or add commentary. Output only the summary.`;
