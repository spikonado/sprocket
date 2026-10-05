import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { fireEvent, render, within } from '@testing-library/react';
import type { AssistantTimelineTool } from '$lib/chat/assistant-timeline';
import WorkTools from './work-tools';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('tool rows', () => {
	it('reveals the full tool log in a tooltip on hover and closes it with Escape', () => {
		const paths = [
			'/home/ubuntu/sprocket/.worktrees/composer-hover-reasoning/apps/web/src/lib/components/model-reasoning-options.tsx',
			'/home/ubuntu/sprocket/.worktrees/composer-hover-reasoning/apps/web/src/lib/components/model-selector.tsx'
		];

		const tool: AssistantTimelineTool = {
			type: 'tool',
			callId: 'patch',
			name: 'apply_patch',
			input: { patch: paths.map((path) => `*** Update File: ${path}`).join('\n') },
			output: { status: 'failed', error: 'The patch did not apply.' }
		};

		const view = render(<WorkTools tools={[tool]} inProgress={false} commands={new Map()} />);
		const rows = [...view.container.querySelectorAll('[data-tool-row]')];
		expect(rows).toHaveLength(paths.length);
		expect(rows.every((row) => !row.hasAttribute('title'))).toBe(true);
		expect(view.container.querySelector('details')).toBeNull();
		expect(view.queryByRole('tooltip')).toBeNull();

		fireEvent.mouseEnter(rows[0]!);
		const tooltip = view.getByRole('tooltip');
		expect(tooltip.textContent).toContain(paths[0]);
		expect(tooltip.textContent).toContain(paths[1]);
		expect(tooltip.textContent).toContain('The patch did not apply.');

		fireEvent.keyDown(rows[0]!, { key: 'Escape' });
		expect(view.queryByRole('tooltip')).toBeNull();
	});

	it('keeps a focused tooltip open after the pointer leaves, then closes it on scroll', () => {
		const tool: AssistantTimelineTool = {
			type: 'tool',
			callId: 'cmd',
			name: 'exec_command',
			input: { cmd: 'sleep 10' },
			output: {}
		};

		const view = render(<WorkTools tools={[tool]} inProgress={false} commands={new Map()} />);
		const row = view.container.querySelector('[data-tool-row]')!;

		fireEvent.focus(row);
		expect(view.getByRole('tooltip').textContent).toContain('sleep 10');
		fireEvent.mouseLeave(row);
		expect(view.getByRole('tooltip').textContent).toContain('sleep 10');

		act(() => {
			window.dispatchEvent(new Event('scroll'));
		});
		expect(view.queryByRole('tooltip')).toBeNull();
	});

	it('places the tooltip above a row when there is not enough room below', () => {
		const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
		const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');

		Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
			configurable: true,
			get() {
				return this.getAttribute('role') === 'tooltip' ? 80 : 24;
			}
		});
		Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
			configurable: true,
			get() {
				return 200;
			}
		});
		vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(760);
		vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(800);
		vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
			this: HTMLElement
		) {
			if (this.getAttribute('role') === 'tooltip') {
				return new DOMRect(10, Number.parseFloat(this.style.top) || 0, 200, 80);
			}

			return new DOMRect(10, 700, 300, 24);
		});

		try {
			const tool: AssistantTimelineTool = {
				type: 'tool',
				callId: 'cmd',
				name: 'exec_command',
				input: { cmd: 'sleep 10' },
				output: {}
			};

			const view = render(<WorkTools tools={[tool]} inProgress={false} commands={new Map()} />);
			fireEvent.mouseEnter(view.container.querySelector('[data-tool-row]')!);
			expect(view.getByRole('tooltip').style.top).toBe('612px');
		} finally {
			if (height) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', height);

			if (width) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width);
		}
	});

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
