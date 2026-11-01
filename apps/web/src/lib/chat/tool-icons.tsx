import {
	BookOpen,
	Bot,
	Camera,
	CircleQuestionMark,
	CreditCard,
	FileCode,
	FileDiff,
	FileText,
	FolderOpen,
	GitPullRequest,
	Globe,
	Hourglass,
	ListChecks,
	NotebookPen,
	Plug,
	Receipt,
	ScrollText,
	Save,
	Search,
	SquareTerminal,
	Terminal,
	Trash2,
	Wrench,
	type LucideIcon
} from 'lucide-react';

/** Small lucide icon for a tool kind / tool-group key. */
export function toolKindIcon(kind: string): LucideIcon {
	switch (kind) {
		case 'apply_patch':
			return FileDiff;
		case 'ask_question':
			return CircleQuestionMark;
		case 'await_question':
		case 'poll_question':
			return Hourglass;
		case 'spawn_subagent':
		case 'control_subagent':
		case 'poll_subagent':
			return Bot;
		case 'list_subagents':
		case 'list_subagent_models':
			return ListChecks;
		case 'check_docs':
			return BookOpen;
		case 'add_artifact':
		case 'create_artifact':
			return FileCode;
		case 'delete_artifact':
			return Trash2;
		case 'save_artifact':
			return Save;
		case 'exec_command':
		case 'exec_cmd':
			return Terminal;
		case 'control_command':
		case 'control_cmd':
		case 'poll_command':
		case 'poll_cmd':
			return SquareTerminal;
		case 'get_workspace_instructions':
			return ScrollText;
		case 'card_checkout':
			return CreditCard;
		case 'report_order':
			return Receipt;
		case 'read_skill':
			return NotebookPen;
		case 'scrape_url':
			return Globe;
		case 'screenshot_url':
			return Camera;
		case 'set_cwd':
			return FolderOpen;
		case 'link_prs':
			return GitPullRequest;
		case 'list_connectors':
			return Plug;
		case 'edit_artifact':
		case 'list_artifacts':
		case 'update_artifact':
		case 'parse_file':
			return FileText;
		case 'web_search':
			return Search;
		case 'write_stdin':
			return SquareTerminal;
		default:
			return Wrench;
	}
}

/** Icon for a timeline tool row (prefers job kind when present). */
export function toolLogIcon(tool: { name: string; job?: { kind: string } | null }): LucideIcon {
	return toolKindIcon(tool.job?.kind ?? tool.name);
}
