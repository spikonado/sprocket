export type ChangeLoopMode = 'cleanup-and-review' | 'cleanup' | 'review';

export const changeLoopOptions: {
	id: ChangeLoopMode;
	label: string;
	triggerLabel: string;
}[] = [
	{ id: 'cleanup-and-review', label: 'Run cleanup and review loop', triggerLabel: '' },
	{ id: 'cleanup', label: 'Run cleanup loop', triggerLabel: '' },
	{ id: 'review', label: 'Run review loop', triggerLabel: '' }
];

const scopeInstructions = `Run this workflow yourself as the main agent in this thread; subagents must not recursively run the loop.
First identify the full current PR and its base, including local pending task changes. Without a PR, identify the complete task changes against the task's starting state. Preserve unrelated pre-existing edits. Give every subagent that full scope and a PR reference or another concrete reference to the changes; inspect the full change, not individual commits. If no relevant changes exist, say so and stop.
Freeze your project edits while each subagent runs; read-only inspection and polling are allowed. Wait for each phase to complete before starting the next. Run relevant checks after edits. An incomplete or failed phase never counts as clean: retry with a fresh subagent using the same scope if appropriate, within the three-round budget; otherwise stop and ask the user how to proceed. Respect cancellation.`;

const cleanupInstructions = `Spawn a fresh cleanup subagent with a prompt explicitly referencing $cleanup, the full change scope, and the PR or other change reference. Have it implement cleanup and report whether it made edits. Its initial prompt is your only communication with it: poll for completion, but send no follow-ups, steering, or answers to its questions. Preserve its changes; you may fix a cleanup regression only when a subsequent reviewer identifies it.`;

const reviewInstructions = `Spawn a fresh read-only review subagent with a prompt like "Review these changes", the full change scope, and the PR or other change reference. Have it report actionable findings without editing. Wait for completion, evaluate every finding yourself, and fix relevant issues; the reviewer may be wrong.`;

export function changeLoopPrompt(mode: ChangeLoopMode): string {
	const instructions: Record<ChangeLoopMode, string> = {
		'cleanup-and-review': `Run the cleanup and review loop for up to three rounds.
In each round:
1. ${cleanupInstructions}
2. After cleanup completes, ${reviewInstructions}
Stop early only when a complete round makes no cleanup edits and has no relevant review findings requiring fixes. Otherwise repeat with fresh subagents, reviewing the entire updated change each time.`,
		cleanup: `Run the cleanup loop for up to three rounds.
In each round, ${cleanupInstructions}
Stop early when a completed cleanup makes no edits; otherwise repeat with a fresh cleanup subagent over the entire updated change. This mode has no reviewer, so you must not reverse cleanup changes yourself.`,
		review: `Run the review loop for up to three rounds.
In each round, ${reviewInstructions}
Stop early when a completed review has no relevant findings requiring fixes; otherwise repeat with a fresh reviewer over the entire updated change.`
	};

	return `${instructions[mode]}

${scopeInstructions}

Three rounds is the maximum for this invocation, including retries. Address relevant findings and run checks after the final round without starting a fourth. Do not claim success with known blocking failures.`;
}
