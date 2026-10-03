import {
	BookOpen,
	Bot,
	Camera,
	CircleDollarSign,
	CircleQuestionMark,
	CreditCard,
	FileCode,
	FileDiff,
	FileText,
	Globe,
	Hourglass,
	ListChecks,
	NotebookPen,
	ScrollText,
	Save,
	Search,
	SquareTerminal,
	Terminal,
	Wallet,
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
		case 'subagent':
		case 'control_subagent':
		case 'poll_subagent':
			return Bot;
		case 'list_subagents':
		case 'list_models':
			return ListChecks;
		case 'check_docs':
			return BookOpen;
		case 'add_artifact':
		case 'create_artifact':
			return FileCode;
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
		case 'mandate_charge':
			return CircleDollarSign;
		case 'mandate_list':
			return ListChecks;
		case 'mandate_report':
			return Wallet;
		case 'mandate_setup':
			return CreditCard;
		case 'mandate_status':
			return ListChecks;
		case 'read_skill':
			return NotebookPen;
		case 'scrape_url':
			return Globe;
		case 'screenshot_url':
			return Camera;
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
