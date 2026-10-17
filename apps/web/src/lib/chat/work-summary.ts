import type { AssistantTimelineWorkBlock } from './assistant-timeline';

const ACTIVITIES = [
	{ names: ['read_skill'], verb: 'read', noun: 'skill' },
	{ names: ['exec_cmd', 'exec_command'], verb: 'ran', noun: 'command' },
	{ names: ['apply_patch'], verb: 'applied', noun: 'patch', plural: 'patches' },
	{ names: ['control_cmd', 'control_command', 'write_stdin'], verb: 'controlled', noun: 'command' },
	{ names: ['web_search'], verb: 'searched', noun: 'time' },
	{ names: ['scrape_url'], verb: 'fetched', noun: 'page' },
	{ names: ['parse_file'], verb: 'parsed', noun: 'file' },
	{ names: ['screenshot_url'], verb: 'captured', noun: 'screenshot' },
	{ names: ['spawn_subagent'], verb: 'started', noun: 'subagent' },
	{ names: ['control_subagent'], verb: 'controlled', noun: 'subagent' },
	{ names: ['list_subagents'], verb: 'listed', noun: 'subagent group' },
	{ names: ['list_subagent_models'], verb: 'listed', noun: 'model group' },
	{ names: ['ask_question'], verb: 'asked', noun: 'question' },
	{ names: ['add_artifact', 'create_artifact'], verb: 'created', noun: 'artifact' },
	{ names: ['edit_artifact', 'update_artifact'], verb: 'updated', noun: 'artifact' },
	{ names: ['save_artifact'], verb: 'saved', noun: 'artifact' },
	{ names: ['delete_artifact'], verb: 'deleted', noun: 'artifact' },
	{ names: ['list_artifacts'], verb: 'listed', noun: 'artifact group' },
	{ names: ['mandate_setup'], verb: 'set up', noun: 'mandate' },
	{ names: ['mandate_list'], verb: 'listed', noun: 'mandate group' },
	{ names: ['mandate_status'], verb: 'checked', noun: 'mandate' },
	{ names: ['mandate_charge'], verb: 'charged', noun: 'payment' },
	{ names: ['mandate_report'], verb: 'reported', noun: 'payment outcome' },
	{ names: ['get_workspace_instructions'], verb: 'read', noun: 'instruction set' },
	{ names: ['check_docs'], verb: 'checked', noun: 'document' }
];

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
			const name = tool.name || tool.job?.kind || 'tool';
			counts[name] = (counts[name] ?? 0) + 1;
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

export function workSummary(counts: Record<string, number> = {}): string {
	const remaining = new Map(Object.entries(counts).filter(([, count]) => count > 0));
	const hasPolls = [...remaining.keys()].some(isPoll);

	for (const name of remaining.keys()) if (isPoll(name)) remaining.delete(name);

	const phrases: string[] = [];

	for (const activity of ACTIVITIES) {
		let count = 0;

		for (const name of activity.names) {
			count += remaining.get(name) ?? 0;
			remaining.delete(name);
		}

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
