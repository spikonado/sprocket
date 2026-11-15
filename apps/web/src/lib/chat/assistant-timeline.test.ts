import { describe, expect, it } from 'vitest';
import {
	assistantTimelineToolError,
	assistantTimelineToolFailureKind,
	buildAssistantTimeline,
	buildCommandSessionCommandMap,
	groupAssistantTimeline,
	groupAssistantTimelineSections,
	isAssistantTimelineToolRunning,
	partitionWorkSectionTools,
	resolveCommandSessionLabel,
	type AssistantTimelineTool,
	type AssistantTimelineWorkBlock
} from '$lib/chat/assistant-timeline';

function tool(
	callId: string,
	name: string,
	overrides: Partial<AssistantTimelineTool> = {}
): AssistantTimelineTool {
	return { type: 'tool', callId, name, input: {}, ...overrides };
}

describe('assistant timeline', () => {
	it('keeps tool calls between surrounding assistant parts and pairs results', () => {
		const timeline = buildAssistantTimeline([
			{ type: 'reasoning', id: 'r1', text: 'Thinking' },
			{ type: 'tool-call', callId: 'call-1', name: 'exec_command', input: { cmd: 'pwd' } },
			{
				type: 'tool-result',
				callId: 'call-1',
				name: 'exec_command',
				output: { output: '/workspace' }
			},
			{ type: 'text', id: 't1', text: 'Done' }
		]);

		expect(timeline.map((item) => item.type)).toEqual(['reasoning', 'tool', 'text']);
		expect(timeline[1]).toMatchObject({
			type: 'tool',
			callId: 'call-1',
			output: { output: '/workspace' }
		});
	});

	it('uses the latest result for a call without changing surrounding part order', () => {
		const timeline = buildAssistantTimeline([
			{ type: 'tool-call', callId: 'call-1', name: 'exec_command', input: { cmd: 'pwd' } },
			{ type: 'tool-result', callId: 'call-1', output: 'first', completedAt: 1_000 },
			{ type: 'text', id: 't1', text: 'Done' },
			{ type: 'tool-result', callId: 'call-1', output: 'latest', completedAt: 2_000 }
		]);

		expect(timeline).toEqual([
			expect.objectContaining({
				type: 'tool',
				callId: 'call-1',
				output: 'latest'
			}),
			{ type: 'text', id: 't1', text: 'Done' }
		]);
	});

	it('hides empty reasoning and keeps later tool then text in arrival order', () => {
		const timeline = buildAssistantTimeline([
			{ type: 'reasoning', id: 'r-empty', text: '' },
			{ type: 'tool-call', callId: 'call-1', name: 'exec_command', input: { cmd: 'pwd' } },
			{
				type: 'tool-result',
				callId: 'call-1',
				name: 'exec_command',
				output: { output: '/workspace' }
			},
			{ type: 'reasoning', id: 'r-blank', text: '   ' },
			{ type: 'text', id: 't1', text: 'Done' }
		]);

		expect(timeline.map((item) => item.type)).toEqual(['tool', 'text']);
		expect(timeline[0]).toMatchObject({ type: 'tool', callId: 'call-1' });
		expect(timeline[1]).toMatchObject({ type: 'text', id: 't1', text: 'Done' });
	});

	it('preserves cancelled vs failed from persisted tool-result status', () => {
		const [cancelled, failed] = buildAssistantTimeline([
			{ type: 'tool-call', callId: 'call-1', name: 'exec_command', input: { cmd: 'one' } },
			{
				type: 'tool-result',
				callId: 'call-1',
				output: { error: 'stopped by user', status: 'cancelled' }
			},
			{ type: 'tool-call', callId: 'call-2', name: 'exec_command', input: { cmd: 'two' } },
			{
				type: 'tool-result',
				callId: 'call-2',
				output: { error: 'command failed', status: 'failed' }
			}
		]);

		expect(cancelled).toMatchObject({ type: 'tool' });
		expect(failed).toMatchObject({ type: 'tool' });

		if (cancelled?.type !== 'tool' || failed?.type !== 'tool') {
			throw new Error('Expected tool timeline items.');
		}

		expect(assistantTimelineToolFailureKind(cancelled, true)).toBe('cancelled');
		expect(assistantTimelineToolError(cancelled, true)).toBe('stopped by user');
		expect(assistantTimelineToolFailureKind(failed, true)).toBe('failed');
		expect(assistantTimelineToolError(failed, true)).toBe('command failed');
		expect(assistantTimelineToolFailureKind(cancelled, false)).toBe('cancelled');
		expect(assistantTimelineToolError(cancelled, false)).toBe('stopped by user');
	});
});

describe('groupAssistantTimeline', () => {
	it('groups consecutive same-type tools and breaks on text or reasoning', () => {
		const blocks = groupAssistantTimeline([
			{ type: 'reasoning', id: 'r1', text: 'plan' },
			tool('c1', 'exec_command'),
			tool('c2', 'exec_command'),
			{ type: 'text', id: 't1', text: 'mid' },
			tool('c3', 'exec_command'),
			tool('c4', 'apply_patch'),
			tool('c5', 'apply_patch')
		]);

		expect(blocks.map((block) => block.type)).toEqual([
			'reasoning',
			'tool-group',
			'text',
			'tool-group',
			'tool-group'
		]);
		expect(blocks[1]).toMatchObject({
			type: 'tool-group',
			toolKey: 'exec_command',
			tools: [{ callId: 'c1' }, { callId: 'c2' }]
		});
		expect(blocks[3]).toMatchObject({
			type: 'tool-group',
			toolKey: 'exec_command',
			tools: [{ callId: 'c3' }]
		});
		expect(blocks[4]).toMatchObject({
			type: 'tool-group',
			toolKey: 'apply_patch',
			tools: [{ callId: 'c4' }, { callId: 'c5' }]
		});
	});
});

describe('groupAssistantTimelineSections', () => {
	it('wraps contiguous reasoning and tool groups into work sections broken by text', () => {
		const sections = groupAssistantTimelineSections(
			groupAssistantTimeline([
				{ type: 'reasoning', id: 'r1', text: 'plan' },
				tool('c1', 'exec_command'),
				tool('c2', 'exec_command'),
				{ type: 'text', id: 't1', text: 'mid' },
				{ type: 'reasoning', id: 'r2', text: 'more' },
				tool('c3', 'apply_patch'),
				{ type: 'text', id: 't2', text: 'done' }
			])
		);

		expect(sections.map((section) => section.type)).toEqual(['work', 'text', 'work', 'text']);
		expect(sections[0]).toMatchObject({
			type: 'work',
			blocks: [
				{ type: 'reasoning', id: 'r1' },
				{ type: 'tool-group', toolKey: 'exec_command' }
			]
		});
		expect(sections[1]).toMatchObject({ type: 'text', id: 't1' });
		expect(sections[2]).toMatchObject({
			type: 'work',
			blocks: [
				{ type: 'reasoning', id: 'r2' },
				{ type: 'tool-group', toolKey: 'apply_patch' }
			]
		});
		expect(sections[3]).toMatchObject({ type: 'text', id: 't2' });
	});
});

describe('partitionWorkSectionTools', () => {
	it.each([
		'exec_command',
		'exec_cmd',
		'write_stdin',
		'control_command',
		'control_cmd',
		'poll_command',
		'poll_cmd',
		'ask_question',
		'poll_question',
		'await_question',
		'card_checkout',
		'poll_checkout',
		'spawn_subagent',
		'control_subagent',
		'poll_subagent',
		'poll_pr'
	])('shows an unfinished %s call as running', (name) => {
		const call = tool('live', name);

		const blocks: AssistantTimelineWorkBlock[] = [
			{ type: 'tool-group', toolKey: name, tools: [call] }
		];

		expect(isAssistantTimelineToolRunning(call, true)).toBe(true);
		expect(partitionWorkSectionTools(blocks, true)).toEqual({
			settledBlocks: [],
			runningTools: [call]
		});
		expect(isAssistantTimelineToolRunning(call, false)).toBe(false);
	});

	it.each([
		'apply_patch',
		'get_workspace_instructions',
		'report_order',
		'read_skill',
		'parse_file',
		'scrape_url',
		'screenshot_url',
		'web_search',
		'bind_artifact',
		'list_artifacts',
		'edit_artifact',
		'save_artifact',
		'unknown_tool'
	])('hides unfinished %s calls while preserving settled calls', (name) => {
		const unfinished = tool('unfinished', name);
		const returned = tool('returned', name, { output: null });

		const blocks: AssistantTimelineWorkBlock[] = [
			{ type: 'tool-group', toolKey: name, tools: [unfinished, returned] }
		];

		expect(isAssistantTimelineToolRunning(unfinished, true)).toBe(false);
		expect(partitionWorkSectionTools(blocks, true)).toEqual({
			settledBlocks: [{ type: 'tool-group', toolKey: name, tools: [returned] }],
			runningTools: []
		});
	});

	it('pulls running tools out and leaves settled reasoning/tools behind', () => {
		const blocks: AssistantTimelineWorkBlock[] = [
			{ type: 'reasoning', id: 'r1', text: 'plan' },
			{
				type: 'tool-group',
				toolKey: 'exec_command',
				tools: [
					tool('done', 'exec_command', {
						input: { cmd: 'done' },
						output: { running: false, success: true }
					}),
					tool('live', 'exec_command', { input: { cmd: 'live' } })
				]
			}
		];

		const { settledBlocks, runningTools } = partitionWorkSectionTools(blocks, true);

		expect(runningTools.map((item) => item.callId)).toEqual(['live']);
		expect(settledBlocks).toEqual([
			expect.objectContaining({ type: 'reasoning', id: 'r1' }),
			expect.objectContaining({
				type: 'tool-group',
				toolKey: 'exec_command',
				tools: [expect.objectContaining({ callId: 'done' })]
			})
		]);
		expect(isAssistantTimelineToolRunning(runningTools[0], true)).toBe(true);
	});

	it('settles yielded calls and shows an in-flight poll as its own running call', () => {
		const blocks: AssistantTimelineWorkBlock[] = [
			{
				type: 'tool-group',
				toolKey: 'exec_command',
				tools: [
					tool('exec-1', 'exec_command', {
						input: { cmd: 'npm run dev' },
						output: { sessionId: '7', running: true }
					})
				]
			},
			{
				type: 'tool-group',
				toolKey: 'write_stdin',
				tools: [tool('monitor-1', 'write_stdin', { input: { sessionId: '7' } })]
			}
		];

		const { settledBlocks, runningTools } = partitionWorkSectionTools(blocks, true);

		expect(runningTools.map((item) => item.callId)).toEqual(['monitor-1']);
		expect(settledBlocks).toEqual([blocks[0]]);
	});

	it.each([true, false])('keeps each returned poll snapshot settled with running=%s', (running) => {
		const blocks: AssistantTimelineWorkBlock[] = [
			{
				type: 'tool-group',
				toolKey: 'exec_command',
				tools: [
					tool('exec-1', 'exec_command', {
						input: { cmd: 'sleep 1' },
						output: { sessionId: '3', running: true }
					})
				]
			},
			{
				type: 'tool-group',
				toolKey: 'write_stdin',
				tools: [
					tool('monitor-1', 'write_stdin', {
						input: { sessionId: '3' },
						output: { running }
					})
				]
			}
		];

		const { settledBlocks, runningTools } = partitionWorkSectionTools(blocks, true);

		expect(runningTools).toEqual([]);
		expect(settledBlocks).toEqual([
			expect.objectContaining({
				type: 'tool-group',
				toolKey: 'exec_command',
				tools: [expect.objectContaining({ callId: 'exec-1' })]
			}),
			expect.objectContaining({
				type: 'tool-group',
				toolKey: 'write_stdin',
				tools: [expect.objectContaining({ callId: 'monitor-1' })]
			})
		]);
	});

	it('settles yielded calls without any later poll or shared session state', () => {
		const blocks: AssistantTimelineWorkBlock[] = [
			{
				type: 'tool-group',
				toolKey: 'exec_command',
				tools: [
					tool('exec-1', 'exec_command', {
						input: { cmd: 'npm run dev' },
						output: { sessionId: '7', running: true }
					})
				]
			}
		];

		const { settledBlocks, runningTools } = partitionWorkSectionTools(blocks, true);
		expect(runningTools).toEqual([]);
		expect(settledBlocks).toEqual([
			expect.objectContaining({
				type: 'tool-group',
				tools: [expect.objectContaining({ callId: 'exec-1' })]
			})
		]);
	});

	it('settles in-flight tools and yielded commands after the run stops', () => {
		const unresolvedTool = tool('patch-1', 'apply_patch');

		const completedTool = tool('patch-2', 'apply_patch', {
			output: { changedFiles: ['a.txt'] }
		});

		const yieldedCommand = tool('exec-1', 'exec_command', {
			input: { cmd: 'npm run dev' },
			output: { sessionId: '7', running: true }
		});

		const blocks: AssistantTimelineWorkBlock[] = [
			{ type: 'tool-group', toolKey: 'apply_patch', tools: [unresolvedTool, completedTool] },
			{ type: 'tool-group', toolKey: 'exec_command', tools: [yieldedCommand] }
		];

		const { settledBlocks, runningTools } = partitionWorkSectionTools(blocks, false);

		expect(runningTools).toEqual([]);
		expect(settledBlocks).toEqual(blocks);
		expect(assistantTimelineToolFailureKind(unresolvedTool, false)).toBe('interrupted');
		expect(assistantTimelineToolError(unresolvedTool, false)).toBe(
			'The agent stopped before this tool call finished.'
		);
		expect(assistantTimelineToolFailureKind(completedTool, false)).toBeUndefined();
		expect(assistantTimelineToolFailureKind(yieldedCommand, false)).toBeUndefined();
	});

	it.each([true, false])(
		'settles returned control_command and poll_command snapshots with running=%s',
		(running) => {
			const blocks: AssistantTimelineWorkBlock[] = [
				{
					type: 'tool-group',
					toolKey: 'exec_command',
					tools: [
						tool('exec-1', 'exec_command', {
							input: { cmd: 'sleep 1' },
							output: { sessionId: '3', running: true, success: false }
						})
					]
				},
				{
					type: 'tool-group',
					toolKey: 'control_command',
					tools: [
						tool('control-1', 'control_command', {
							input: { sessionId: '3', action: 'terminate' },
							output: { running, success: !running }
						})
					]
				},
				{
					type: 'tool-group',
					toolKey: 'poll_command',
					tools: [
						tool('poll-1', 'poll_command', {
							input: { sessionId: '3' },
							output: { running, success: !running }
						})
					]
				}
			];

			const { settledBlocks, runningTools } = partitionWorkSectionTools(blocks, true);

			expect(runningTools).toEqual([]);
			expect(settledBlocks).toEqual(blocks);
		}
	);

	it('shows an in-flight poll_command as its own running call', () => {
		const blocks: AssistantTimelineWorkBlock[] = [
			{
				type: 'tool-group',
				toolKey: 'exec_command',
				tools: [
					tool('exec-1', 'exec_command', {
						input: { cmd: 'npm run dev' },
						output: { sessionId: '7', running: true, success: false }
					})
				]
			},
			{
				type: 'tool-group',
				toolKey: 'poll_command',
				tools: [tool('poll-1', 'poll_command', { input: { sessionId: '7' } })]
			}
		];

		const { settledBlocks, runningTools } = partitionWorkSectionTools(blocks, true);

		expect(runningTools.map((item) => item.callId)).toEqual(['poll-1']);
		expect(settledBlocks).toEqual([blocks[0]]);
	});
});

describe('command session labels', () => {
	it('resolves write_stdin labels from the originating exec_command', () => {
		const tools = [
			tool('exec-1', 'exec_command', {
				input: { cmd: 'cargo test' },
				output: { command: 'cargo test', sessionId: '9' }
			}),
			tool('monitor-1', 'write_stdin', { input: { sessionId: '9' } })
		];

		expect(resolveCommandSessionLabel(tools[1], buildCommandSessionCommandMap(tools))).toBe(
			'cargo test'
		);
	});

	it('maps sessions from exec_command outputs and input sessions for control/poll', () => {
		const tools = [
			tool('exec-1', 'exec_command', {
				input: { cmd: 'cargo test' },
				output: { sessionId: '9', running: true, success: false }
			}),
			tool('control-1', 'control_command', {
				input: { sessionId: '9', action: 'write', chars: 'y\n' }
			}),
			tool('poll-1', 'poll_command', { input: { sessionId: '9' } })
		];

		const map = buildCommandSessionCommandMap(tools);

		expect(map.get('9')).toBe('cargo test');
		expect(resolveCommandSessionLabel(tools[1], map)).toBe('cargo test');
		expect(resolveCommandSessionLabel(tools[2], map)).toBe('cargo test');
	});

	it('prefers the command in control/poll output over the session map', () => {
		const tools = [
			tool('exec-1', 'exec_command', {
				input: { cmd: 'cargo test' },
				output: { sessionId: '9', running: true, success: false }
			}),
			tool('poll-1', 'poll_command', {
				input: { sessionId: '9' },
				output: {
					command: 'cargo test',
					workdir: '/repo',
					running: false,
					success: true,
					exitCode: 0
				}
			}),
			tool('control-1', 'control_command', {
				input: { sessionId: '9', action: 'terminate' },
				output: { command: 'cargo test', workdir: '/repo', running: false, success: true }
			})
		];

		const map = buildCommandSessionCommandMap(tools);

		expect(resolveCommandSessionLabel(tools[1], map)).toBe('cargo test');
		expect(resolveCommandSessionLabel(tools[2], map)).toBe('cargo test');
	});

	it('labels later polls from a prior result and its input sessionId', () => {
		const tools = [
			tool('poll-1', 'poll_command', {
				input: { sessionId: '9' },
				output: { command: 'cargo test', workdir: '/repo', running: true, success: false }
			}),
			tool('poll-2', 'poll_command', { input: { sessionId: '9' } })
		];

		const map = buildCommandSessionCommandMap(tools);

		expect(map.get('9')).toBe('cargo test');
		expect(resolveCommandSessionLabel(tools[0], map)).toBe('cargo test');
		expect(resolveCommandSessionLabel(tools[1], map)).toBe('cargo test');
	});

	it('keeps legacy write_stdin labels from output command without a sessionId', () => {
		const tools = [
			tool('stdin-1', 'write_stdin', {
				input: { sessionId: '3' },
				output: { command: 'npm run dev', workdir: '/app', running: false, success: true }
			})
		];

		expect(resolveCommandSessionLabel(tools[0], buildCommandSessionCommandMap(tools))).toBe(
			'npm run dev'
		);
	});
});
