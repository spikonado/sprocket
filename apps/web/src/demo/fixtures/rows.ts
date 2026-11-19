import { isCommandToolKind } from '@convex/lib/commandToolKinds';
import type { TranscriptRow } from '$lib/types/sprocket';
import type { TranscriptFixture } from './types';

type ToolRow = Extract<TranscriptRow, { kind: 'tool' }>;

type ToolOptions = Partial<Pick<ToolRow, 'status' | 'error' | 'action'>>;

type WorkStep =
	| { kind: 'reasoning'; label: string; text: string }
	| ({ kind: 'tool'; name: string; summary: string } & ToolOptions);

export type Step =
	| { kind: 'prompt'; text: string }
	| { kind: 'text'; text: string }
	| { kind: 'work'; steps: WorkStep[] };

const SUMMARY_CHARS = 300;

const TOOL_LABELS = new Map([
	['spawn_subagent', 'Delegated Tasks'],
	['control_subagent', 'Controlled Subagents'],
	['poll_subagent', 'Polled Subagents'],
	['list_subagents', 'Listed Subagents'],
	['bind_artifact', 'Bound Artifact'],
	['parse_file', 'Parsed File'],
	['lookup_parts', 'Checked Parts'],
	['set_cwd', 'Changed Directory'],
	['link_prs', 'Linked PRs']
]);

export const prompt = (text: string): Step => ({ kind: 'prompt', text });

export const say = (text: string): Step => ({ kind: 'text', text });

export const work = (...steps: WorkStep[]): Step => ({ kind: 'work', steps });

export const think = (label: string, text: string): WorkStep => ({
	kind: 'reasoning',
	label,
	text
});

export const tool = (name: string, summary: string, options: ToolOptions = {}): WorkStep => ({
	kind: 'tool',
	name,
	summary,
	...options
});

/** Rows shaped like the local server's, which previews each tool's first line and serves the rest as the item's detail. */
export function recordRun(runId: string, steps: Step[]): TranscriptFixture {
	const fixture: TranscriptFixture = { rows: [], work: {}, items: {} };
	let sequence = 0;
	const nextId = (kind: string) => `${kind}:${runId}:${sequence++}`;

	for (const step of steps) {
		if (step.kind === 'prompt') {
			fixture.rows.push({
				id: nextId('prompt'),
				runId,
				kind: 'prompt',
				text: step.text,
				attachments: []
			});
		} else if (step.kind === 'text') {
			fixture.rows.push({
				id: nextId('text'),
				runId,
				kind: 'text',
				text: step.text,
				running: false
			});
		} else {
			const workId = nextId('work');
			const toolCounts: Record<string, number> = {};

			const items = step.steps.map((item): TranscriptRow => {
				const id = nextId(item.kind);

				if (item.kind === 'reasoning') {
					const row = { id, runId, kind: 'reasoning', label: item.label, running: false } as const;

					fixture.items[id] = { ...row, text: `**${item.label}**\n\n${item.text}` };

					return row;
				}

				const { kind, name, summary, ...options } = item;
				const command = isCommandToolKind(name) ? summary : undefined;
				const preview = summary.split('\n', 1)[0].slice(0, SUMMARY_CHARS);
				const hasMore = command !== undefined || preview !== summary;
				const label = TOOL_LABELS.get(name);
				toolCounts[name] = (toolCounts[name] ?? 0) + 1;

				const row: ToolRow = {
					id,
					runId,
					kind,
					name,
					summary: preview,
					hasMore,
					status: 'completed',
					...options
				};

				if (label) row.label = label;

				if (hasMore) {
					const detail: ToolRow = { ...row, summary, hasMore: false };

					if (command) detail.command = command;
					fixture.items[id] = detail;
				}

				return row;
			});

			fixture.rows.push({ id: workId, runId, kind: 'work', toolCounts, running: false });
			fixture.work[workId] = items;
		}
	}

	return fixture;
}

export function joinRuns(...runs: TranscriptFixture[]): TranscriptFixture {
	return {
		rows: runs.flatMap((run) => run.rows),
		work: Object.assign({}, ...runs.map((run) => run.work)),
		items: Object.assign({}, ...runs.map((run) => run.items))
	};
}
