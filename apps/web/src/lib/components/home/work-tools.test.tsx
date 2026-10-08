import { describe, expect, it } from 'vitest';
import { render, within } from '@testing-library/react';
import type { AssistantTimelineTool } from '$lib/chat/assistant-timeline';
import WorkTools from './work-tools';

describe('tool rows', () => {
	it('shows summaries without redundant labels and uses singular labels for single-item tools', () => {
		const tools: AssistantTimelineTool[] = [
			{
				type: 'tool',
				callId: 'patch',
				name: 'apply_patch',
				input: {
					patch: '*** Begin Patch\n*** Update File: a.ts\n*** Update File: b.ts\n*** End Patch'
				}
			},
			{ type: 'tool', callId: 'ask', name: 'ask_question', input: { question: 'Which layout?' } },
			{ type: 'tool', callId: 'wait', name: 'poll_question', input: {} },
			{
				type: 'tool',
				callId: 'subagents',
				name: 'list_subagents',
				input: { parentThreadId: 'parent' }
			},
			{ type: 'tool', callId: 'models', name: 'list_subagent_models', input: {} },
			{
				type: 'tool',
				callId: 'answer',
				name: 'control_subagent',
				input: { action: 'answer_question' }
			},
			{ type: 'tool', callId: 'skill', name: 'read_skill', input: { name: 'agent-browser' } },
			{ type: 'tool', callId: 'url', name: 'scrape_url', input: { url: 'https://react.dev' } },
			{ type: 'tool', callId: 'search', name: 'web_search', input: { query: 'React reference' } },
			{ type: 'tool', callId: 'create', name: 'add_artifact', input: { path: 'notes.md' } },
			{ type: 'tool', callId: 'edit', name: 'edit_artifact', input: { path: 'notes.md' } },
			{ type: 'tool', callId: 'save', name: 'save_artifact', input: { path: 'notes.md' } },
			{ type: 'tool', callId: 'delete', name: 'delete_artifact', input: { path: 'notes.md' } },
			{
				type: 'tool',
				callId: 'list',
				name: 'list_artifacts',
				input: {},
				output: { artifacts: [{}, {}] }
			},
			{ type: 'tool', callId: 'parse', name: 'parse_file', input: { path: 'design.pdf' } },
			{
				type: 'tool',
				callId: 'screenshot',
				name: 'screenshot_url',
				input: { url: 'https://react.dev' }
			}
		];

		const settledTools = tools.map((tool) => ({ ...tool, output: tool.output ?? {} }));
		const view = render(<WorkTools tools={settledTools} inProgress={false} commands={new Map()} />);
		const rows = [...view.container.querySelectorAll('[data-tool-row]')];

		expect(rows.map((row) => row.textContent)).toEqual([
			'a.ts',
			'b.ts',
			'Which layout?',
			'Waiting for answer',
			'Listed Subagents',
			'Listed Subagent Models',
			'Controlled Subagents:Answered question',
			'$agent-browser',
			'https://react.dev',
			'React reference',
			'Created Artifact:notes.md',
			'Updated Artifact:notes.md',
			'Saved Artifact:notes.md',
			'Deleted Artifact:notes.md',
			'Listed Artifacts:2 artifacts',
			'Parsed File:design.pdf',
			'Captured Screenshot:https://react.dev'
		]);
		expect(rows.every((row) => row.firstElementChild?.tagName === 'svg')).toBe(true);
	});

	it('keeps a multi-file call failure attached once after the file rows', () => {
		const tool: AssistantTimelineTool = {
			type: 'tool',
			callId: 'patch',
			name: 'apply_patch',
			input: {
				patch: '*** Begin Patch\n*** Update File: a.ts\n*** Update File: b.ts\n*** End Patch'
			},
			output: { status: 'failed', error: 'The patch did not apply.' }
		};

		const view = render(<WorkTools tools={[tool]} inProgress={false} commands={new Map()} />);

		expect(
			[...view.container.querySelectorAll('[data-tool-row]')].map((row) => row.textContent)
		).toEqual(['a.ts', 'b.ts(failed)']);
		expect(
			within(view.container)
				.getAllByRole('status')
				.map((row) => row.textContent)
		).toEqual(['The patch did not apply.']);
	});
});
