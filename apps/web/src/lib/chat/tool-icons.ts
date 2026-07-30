import {
	BookOpen,
	CircleQuestionMark,
	FileCode,
	FileDiff,
	FileText,
	Globe,
	Hourglass,
	NotebookPen,
	ScrollText,
	Search,
	SquareTerminal,
	Terminal,
	Wrench,
	type LucideIcon
} from '@lucide/svelte';

const TOOL_KIND_ICONS: Record<string, LucideIcon> = {
	apply_patch: FileDiff,
	ask_question: CircleQuestionMark,
	await_question: Hourglass,
	check_docs: BookOpen,
	create_artifact: FileCode,
	exec_command: Terminal,
	get_workspace_instructions: ScrollText,
	read_skill: NotebookPen,
	scrape_url: Globe,
	update_artifact: FileText,
	web_search: Search,
	write_stdin: SquareTerminal
};

/** Small lucide icon for a tool kind / tool-group key. */
export function toolKindIcon(kind: string): LucideIcon {
	return TOOL_KIND_ICONS[kind] ?? Wrench;
}

/** Icon for a timeline tool row (prefers job kind when present). */
export function toolLogIcon(tool: { name: string; job?: { kind: string } | null }): LucideIcon {
	return toolKindIcon(tool.job?.kind ?? tool.name);
}
