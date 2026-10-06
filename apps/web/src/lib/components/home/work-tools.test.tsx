import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { fireEvent, render, within } from '@testing-library/react';
import type { AssistantTimelineTool } from '$lib/chat/assistant-timeline';
import WorkTools from './work-tools';

afterEach(() => {
	vi.useRealTimers();
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

	it('keeps a focused tooltip open after the pointer leaves and after scroll', () => {
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
		expect(view.getByRole('tooltip').textContent).toContain('sleep 10');
	});

	it('hides a focused log outside the conversation and restores it when its row returns', () => {
		let rowTop = 200;

		vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
			this: HTMLElement
		) {
			return this.hasAttribute('data-conversation-viewport')
				? new DOMRect(0, 100, 500, 300)
				: new DOMRect(10, rowTop, 300, 24);
		});

		const view = render(
			<div data-conversation-viewport>
				<WorkTools
					tools={[
						{
							type: 'tool',
							callId: 'cmd',
							name: 'exec_command',
							input: { cmd: 'sleep 10' },
							output: {}
						}
					]}
					inProgress={false}
					commands={new Map()}
				/>
			</div>
		);

		const row = view.container.querySelector<HTMLElement>('[data-tool-row]')!;

		act(() => row.focus());
		expect(view.getByRole('tooltip').textContent).toContain('sleep 10');

		rowTop = 50;
		fireEvent.scroll(view.container.firstElementChild!);
		expect(view.queryByRole('tooltip')).toBeNull();
		expect(document.activeElement).toBe(row);

		rowTop = 250;
		fireEvent.scroll(view.container.firstElementChild!);
		expect(view.getByRole('tooltip').textContent).toContain('sleep 10');

		fireEvent.keyDown(row, { key: 'Escape' });
		expect(document.activeElement).toBe(row);
		expect(view.queryByRole('tooltip')).toBeNull();
		fireEvent.mouseEnter(row);
		expect(view.queryByRole('tooltip')).toBeNull();
		fireEvent.scroll(window);
		expect(view.queryByRole('tooltip')).toBeNull();
	});

	it('keeps the log open while the pointer moves from the row to the tooltip', () => {
		vi.useFakeTimers();

		const view = render(
			<WorkTools
				tools={[
					{
						type: 'tool',
						callId: 'cmd',
						name: 'exec_command',
						input: { cmd: 'sleep 10' },
						output: {}
					}
				]}
				inProgress={false}
				commands={new Map()}
			/>
		);

		const row = view.container.querySelector('[data-tool-row]')!;

		fireEvent.mouseEnter(row);
		const tooltip = view.getByRole('tooltip');
		fireEvent.mouseLeave(row);
		fireEvent.mouseEnter(tooltip);
		act(() => vi.advanceTimersByTime(150));
		expect(view.getByRole('tooltip')).toBe(tooltip);

		fireEvent.keyDown(window, { key: 'Escape' });
		expect(view.queryByRole('tooltip')).toBeNull();
		fireEvent.mouseLeave(row);
		act(() => vi.advanceTimersByTime(150));
		fireEvent.mouseEnter(row);
		expect(view.getByRole('tooltip').textContent).toContain('sleep 10');

		fireEvent.mouseLeave(view.getByRole('tooltip'));
		act(() => vi.advanceTimersByTime(150));
		expect(view.queryByRole('tooltip')).toBeNull();
	});

	it('lets a keyboard user scroll a long log without scrolling the conversation', () => {
		const view = render(
			<WorkTools
				tools={[
					{
						type: 'tool',
						callId: 'cmd',
						name: 'exec_command',
						input: { cmd: 'echo long command' },
						output: {}
					}
				]}
				inProgress={false}
				commands={new Map()}
			/>
		);

		const row = view.container.querySelector<HTMLElement>('[data-tool-row]')!;

		act(() => row.focus());
		const tooltip = view.getByRole('tooltip');
		vi.spyOn(tooltip, 'scrollHeight', 'get').mockReturnValue(1000);
		vi.spyOn(tooltip, 'clientHeight', 'get').mockReturnValue(100);

		fireEvent.keyDown(row, { key: 'PageDown' });
		expect(tooltip.scrollTop).toBe(100);
		fireEvent.keyDown(row, { key: 'ArrowUp' });
		expect(tooltip.scrollTop).toBe(60);
		expect(document.activeElement).toBe(row);
	});

	it('places a long tooltip above its row and keeps it inside a smaller conversation viewport', () => {
		vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
			this: HTMLElement
		) {
			return this.getAttribute('role') === 'tooltip' ? 600 : 24;
		});
		vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(500);
		vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(760);
		vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(800);
		vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
			this: HTMLElement
		) {
			if (this.hasAttribute('data-conversation-viewport')) {
				return new DOMRect(100, 100, 300, 400);
			}

			return new DOMRect(110, 440, 280, 24);
		});

		const tool: AssistantTimelineTool = {
			type: 'tool',
			callId: 'cmd',
			name: 'exec_command',
			input: { cmd: 'sleep 10' },
			output: {}
		};

		const view = render(
			<div data-conversation-viewport>
				<WorkTools tools={[tool]} inProgress={false} commands={new Map()} />
			</div>
		);

		fireEvent.mouseEnter(view.container.querySelector('[data-tool-row]')!);
		const tooltip = view.getByRole('tooltip');

		expect(tooltip.style.top).toBe('108px');
		expect(tooltip.style.left).toBe('108px');
		expect(tooltip.style.maxHeight).toBe('324px');
		expect(tooltip.style.maxWidth).toBe('284px');
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
