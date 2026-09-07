import {
	BookOpen,
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
	Search,
	SquareTerminal,
	Terminal,
	Wallet,
	Wrench,
	type LucideIcon
} from '@lucide/svelte';

/** Small lucide icon for a tool kind / tool-group key. */
export function toolKindIcon(kind: string): LucideIcon {
	switch (kind) {
		case 'apply_patch':
			return FileDiff;
		case 'ask_question':
			return CircleQuestionMark;
		case 'await_question':
			return Hourglass;
		case 'check_docs':
			return BookOpen;
		case 'create_artifact':
			return FileCode;
		case 'exec_command':
			return Terminal;
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
