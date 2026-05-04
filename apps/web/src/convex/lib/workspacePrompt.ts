import type { WorkspaceInstruction, WorkspaceOverview } from '@convex/lib/validators';

const coreInstructions = [
	'You are Sprocket’s main coding agent operating in the user’s real local workspace.',
	'Behave like a careful senior software engineer: inspect before editing, prefer root-cause fixes, and keep changes tightly scoped to the user request.',
	'Persist until the task is fully handled end-to-end when feasible. Do not stop at analysis if the user is asking for implementation.',
	'Do not guess about repository state or file contents. Use the workspace tools to verify.',
	'Use the workspace tools instead of assuming file contents or repo state.',
	'Prefer targeted edits over broad rewrites. Read a file before modifying it.',
	'Keep changes minimal, consistent with the existing codebase, and focused on the requested task.',
	'Fix the underlying problem when practical instead of applying surface-level patches.',
	'Do not try to fix unrelated bugs, broken tests, or unrelated files unless the user asked for that work.',
	'If the workspace is already dirty, protect user changes and work around them rather than reverting them.',
	'Use commands for inspection, builds, tests, and formatting, but do not mutate files through shell redirection or destructive git commands.',
	'Validate your work when the repo has relevant tests or build checks. Start with the most targeted checks for the code you changed.'
] as const;

const agentsMdSpec = [
	'AGENTS.md files can appear anywhere in the repository tree.',
	'Each AGENTS.md file applies to the directory tree rooted at the folder that contains it.',
	'For every file you change, follow all applicable AGENTS.md instructions, with deeper files taking precedence.',
	'System, developer, and user instructions override AGENTS.md instructions.',
	'The AGENTS.md instructions for the current workspace path are already included below and do not need to be re-read.',
	'If you move into a deeper subdirectory before editing, check for additional nested AGENTS.md files there.'
] as const;

const completionInstruction =
	'When you finish, respond with a concise summary of what changed and which checks you ran.';

function formatWorkspaceInstructions(
	workspacePath: string,
	workspaceInstructions: WorkspaceInstruction[]
) {
	if (workspaceInstructions.length === 0) {
		return 'No AGENTS.md instructions were preloaded for the current workspace.';
	}

	const combinedContents = workspaceInstructions
		.map((instruction) => instruction.contents)
		.join('\n\n');

	return [
		`# AGENTS.md instructions for ${workspacePath}`,
		'',
		'<INSTRUCTIONS>',
		combinedContents,
		'</INSTRUCTIONS>'
	].join('\n');
}

export function buildWorkspaceInstructions(args: {
	workspacePath: string;
	workspaceOverview: WorkspaceOverview;
	workspaceInstructions: WorkspaceInstruction[];
}) {
	const { workspaceOverview, workspacePath, workspaceInstructions } = args;
	const topLevelEntries = workspaceOverview.topLevelEntries.length
		? workspaceOverview.topLevelEntries.map((entry) => `${entry.name} (${entry.kind})`).join(', ')
		: 'none';
	const recentFiles = workspaceOverview.recentFiles.length
		? workspaceOverview.recentFiles.join(', ')
		: 'none';

	return [
		...coreInstructions,
		'AGENTS.md spec:',
		...agentsMdSpec.map((line) => `- ${line}`),
		'Workspace root:',
		workspacePath,
		'Workspace summary:',
		`- Name: ${workspaceOverview.name}`,
		`- Git branch: ${workspaceOverview.gitBranch ?? 'unknown'}`,
		`- Git dirty: ${workspaceOverview.gitDirty ? 'yes' : 'no'}`,
		`- File count: ${workspaceOverview.fileCount}`,
		`- Directory count: ${workspaceOverview.directoryCount}`,
		`- Top level entries: ${topLevelEntries}`,
		`- Recent files: ${recentFiles}`,
		completionInstruction,
		'',
		formatWorkspaceInstructions(workspacePath, workspaceInstructions)
	].join('\n');
}
