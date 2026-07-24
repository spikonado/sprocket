// Keep the preamble and <conversation_summary> wrapper in sync with
// `context_summary_text` in crates/sprocket-agent/src/compaction.rs.
const COMPACTED_CONTEXT_PREAMBLE =
	'The conversation context was automatically compacted. Treat this summary as authoritative, continue the current task from this state, and do not redo completed work.';

export function contextSummaryText(summary: string): string {
	return `${COMPACTED_CONTEXT_PREAMBLE}\n\n<conversation_summary>\n${summary}\n</conversation_summary>`;
}

export const COMPACTION_MAX_OUTPUT_TOKENS = 12_000;

export const CONTEXT_COMPACTION_INSTRUCTIONS = `Summarize the supplied coding-agent conversation so another agent can continue without the original messages.

Preserve:
- every user request and the current objective
- decisions, constraints, plans, and unresolved questions
- files inspected or changed and the important technical details
- tool results, errors, tests, and commands that still matter
- completed work and the exact next steps

Be dense and factual. Do not address the user, continue the task, call tools, or add commentary. Output only the summary.`;
