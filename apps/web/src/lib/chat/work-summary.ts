import type { Infer } from 'convex/values';
import type { vCurrentExecutorJobKind } from '@convex/lib/validators';
import type { AssistantTimelineWorkBlock } from './assistant-timeline';

type Activity = { verb: string; noun: string; plural?: string };

type SummarizedToolName = Exclude<Infer<typeof vCurrentExecutorJobKind>, `poll_${string}`>;

// Typed against the current tool list so a new tool fails typechecking until it has an entry here.
const ACTIVITIES: Record<SummarizedToolName | 'check_docs', Activity> = {
	read_skill: { verb: 'read', noun: 'skill' },
	exec_cmd: { verb: 'ran', noun: 'command' },
	apply_patch: { verb: 'applied', noun: 'patch', plural: 'patches' },
	control_cmd: { verb: 'controlled', noun: 'command' },
	web_search: { verb: 'searched', noun: 'time' },
	scrape_url: { verb: 'fetched', noun: 'page' },
	parse_file: { verb: 'parsed', noun: 'file' },
	screenshot_url: { verb: 'captured', noun: 'screenshot' },
	set_cwd: { verb: 'changed', noun: 'directory', plural: 'directories' },
	link_prs: { verb: 'linked', noun: 'PR group' },
	spawn_subagent: { verb: 'started', noun: 'subagent' },
	control_subagent: { verb: 'controlled', noun: 'subagent' },
	list_subagents: { verb: 'listed', noun: 'subagent group' },
	list_subagent_models: { verb: 'listed', noun: 'model group' },
	ask_question: { verb: 'asked', noun: 'question' },
	add_artifact: { verb: 'created', noun: 'artifact' },
	edit_artifact: { verb: 'updated', noun: 'artifact' },
	save_artifact: { verb: 'saved', noun: 'artifact' },
	delete_artifact: { verb: 'deleted', noun: 'artifact' },
	list_artifacts: { verb: 'listed', noun: 'artifact group' },
	mandate_setup: { verb: 'set up', noun: 'mandate' },
	mandate_list: { verb: 'listed', noun: 'mandate group' },
	mandate_status: { verb: 'checked', noun: 'mandate' },
	mandate_charge: { verb: 'charged', noun: 'payment' },
	mandate_report: { verb: 'reported', noun: 'payment outcome' },
	get_workspace_instructions: { verb: 'read', noun: 'instruction set' },
	check_docs: { verb: 'checked', noun: 'document' }
};

const LEGACY_TOOL_NAMES = new Map<string, keyof typeof ACTIVITIES>([
	['exec_command', 'exec_cmd'],
	['control_command', 'control_cmd'],
	['write_stdin', 'control_cmd'],
	['create_artifact', 'add_artifact'],
	['update_artifact', 'edit_artifact']
]);

function isPoll(name: string): boolean {
	return name.startsWith('poll_') || name === 'await_question';
}

export function workToolCounts(
	blocks: readonly AssistantTimelineWorkBlock[],
	excludedCallIds: ReadonlySet<string> = new Set()
) {
	const counts: Record<string, number> = {};
	const seen = new Set<string>();

	for (const block of blocks) {
		if (block.type !== 'tool-group') continue;

		for (const tool of block.tools) {
			if (seen.has(tool.callId) || excludedCallIds.has(tool.callId)) continue;
			seen.add(tool.callId);
			counts[tool.name] = (counts[tool.name] ?? 0) + 1;
		}
	}

	return counts;
}

export function mergeWorkToolCounts(
	left: Record<string, number> = {},
	right: Record<string, number> = {}
) {
	const counts = { ...left };

	for (const [name, count] of Object.entries(right)) counts[name] = (counts[name] ?? 0) + count;

	return counts;
}

export function workSummary(counts: Record<string, number>): string {
	const remaining = new Map<string, number>();
	let hasPolls = false;

	for (const [name, count] of Object.entries(counts)) {
		if (count <= 0) continue;

		if (isPoll(name)) {
			hasPolls = true;
			continue;
		}

		const currentName = LEGACY_TOOL_NAMES.get(name) ?? name;
		remaining.set(currentName, (remaining.get(currentName) ?? 0) + count);
	}

	const phrases: string[] = [];

	for (const [name, activity] of Object.entries(ACTIVITIES)) {
		const count = remaining.get(name) ?? 0;
		remaining.delete(name);

		if (count > 0) {
			const noun = count === 1 ? activity.noun : (activity.plural ?? `${activity.noun}s`);
			phrases.push(`${activity.verb} ${count} ${noun}`);
		}
	}

	const otherCount = [...remaining.values()].reduce((total, count) => total + count, 0);

	if (otherCount > 0) phrases.push(`used ${otherCount} ${otherCount === 1 ? 'tool' : 'tools'}`);

	const summary = phrases.map((phrase) => phrase[0].toUpperCase() + phrase.slice(1)).join('; ');

	return summary ? summary : hasPolls ? 'Polled tool calls' : 'Reasoned';
}
