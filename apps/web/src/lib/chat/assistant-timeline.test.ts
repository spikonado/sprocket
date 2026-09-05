import { describe, expect, it } from 'vitest';
import {
	assistantTimelinePartKey,
	assistantTimelineToolError,
	assistantTimelineToolFailureKind,
	assistantTimelineToolKey,
	assistantTimelineWorkSectionKey,
	buildAssistantTimeline,
	buildCommandSessionCommandMap,
	buildOpenExecCommandSessions,
	groupAssistantTimeline,
	groupAssistantTimelineSections,
	isAssistantResponseStreaming,
	isAssistantTimelineToolRunning,
	partitionWorkSectionTools,
	resolveCommandSessionLabel,
	workSectionTimingAnchor,
	type AssistantTimelineTool,
	type AssistantTimelineWorkBlock
} from '$lib/chat/assistant-timeline';
import type { ExecutorJob } from '$lib/types/sprocket';

function executorJobId(value: string): ExecutorJob['_id'] {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return value as ExecutorJob['_id'];
}

function executorThreadId(value: string): ExecutorJob['threadId'] {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return value as ExecutorJob['threadId'];
}

function executorRunId(value: string): ExecutorJob['runId'] {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return value as ExecutorJob['runId'];
}

function executorJob(
	id: string,
	sequence: number,
	overrides: Partial<ExecutorJob> = {}
): ExecutorJob {
	return {
		_id: executorJobId(id),
		threadId: executorThreadId('thread'),
		runId: executorRunId('run'),
		kind: 'exec_command',
		payload: { cmd: id },
		hidden: false,
		status: 'pending',
		enqueuedAt: sequence,
		sequence,
		...overrides
	};
}

function tool(
	callId: string,
	name: string,
	overrides: Partial<AssistantTimelineTool> = {}
): AssistantTimelineTool {
	return { type: 'tool', callId, name, input: {}, ...overrides };
}

describe('assistant response streaming', () => {
	it('stays active between completion calls until the run itself finishes', () => {
		const runId = executorRunId('run');

		expect(isAssistantResponseStreaming({ runId, runStatus: 'completed' }, runId)).toBe(true);
		expect(isAssistantResponseStreaming({ runId, runStatus: 'running' }, null)).toBe(false);
	});
});

describe('assistant timeline', () => {
	it('keeps tool calls between surrounding assistant parts and pairs results', () => {
		const timeline = buildAssistantTimeline(
			[
				{ type: 'reasoning', id: 'r1', text: 'Thinking' },
				{ type: 'tool-call', callId: 'call-1', name: 'exec_command', input: { cmd: 'pwd' } },
				{
					type: 'tool-result',
					callId: 'call-1',
					name: 'exec_command',
					output: { output: '/workspace' }
				},
				{ type: 'text', id: 't1', text: 'Done' }
			],
			[]
		);

		expect(timeline.map((item) => item.type)).toEqual(['reasoning', 'tool', 'text']);
		expect(timeline[1]).toMatchObject({
			type: 'tool',
			callId: 'call-1',
			output: { output: '/workspace' }
		});
	});

	it('correlates reversed same-name jobs by payload and keeps remaining jobs visible', () => {
		const first = executorJob('job-1', 1, { payload: { cmd: 'one' } });
		const second = executorJob('job-2', 2, { payload: { cmd: 'two' } });
		const remaining = executorJob('job-3', 3, {
			kind: 'apply_patch',
			payload: { patch: 'diff --git a/new.txt b/new.txt' }
		});
		const timeline = buildAssistantTimeline(
			[
				{ type: 'tool-call', callId: 'call-1', name: 'exec_command', input: { cmd: 'one' } },
				{ type: 'tool-call', callId: 'call-2', name: 'exec_command', input: { cmd: 'two' } }
			],
			[second, first, remaining]
		);

		expect(timeline).toHaveLength(3);
		expect(timeline[0]).toMatchObject({ type: 'tool', job: { _id: first._id } });
		expect(timeline[1]).toMatchObject({ type: 'tool', job: { _id: second._id } });
		expect(timeline[2]).toMatchObject({ type: 'tool', job: { _id: remaining._id } });
	});

	it('keeps ambiguous same-name jobs separate from streamed calls', () => {
		const first = executorJob('job-1', 1, { payload: { cmd: 'persisted-one' } });
		const second = executorJob('job-2', 2, { payload: { cmd: 'persisted-two' } });
		const timeline = buildAssistantTimeline(
			[
				{
					type: 'tool-call',
					callId: 'call-1',
					name: 'exec_command',
					input: { cmd: 'streamed-one' }
				},
				{
					type: 'tool-call',
					callId: 'call-2',
					name: 'exec_command',
					input: { cmd: 'streamed-two' }
				}
			],
			[first, second]
		);

		expect(timeline).toHaveLength(4);
		expect(timeline.slice(0, 2)).toEqual([
			expect.not.objectContaining({ job: expect.anything() }),
			expect.not.objectContaining({ job: expect.anything() })
		]);
		expect(timeline.slice(2)).toEqual([
			expect.objectContaining({ job: expect.objectContaining({ _id: first._id }) }),
			expect.objectContaining({ job: expect.objectContaining({ _id: second._id }) })
		]);
	});

	it('exposes errors from persisted tool results when no live job exists', () => {
		const [tool] = buildAssistantTimeline(
			[
				{ type: 'tool-call', callId: 'call-1', name: 'exec_command', input: { cmd: 'false' } },
				{
					type: 'tool-result',
					callId: 'call-1',
					output: { error: 'command failed', status: 'failed' }
				}
			],
			[]
		);

		expect(tool).toMatchObject({ type: 'tool' });
		if (tool?.type !== 'tool') throw new Error('Expected a tool timeline item.');
		expect(assistantTimelineToolError(tool, true)).toBe('command failed');
	});

	it('exposes the error or cancelled state for live cancelled jobs', () => {
		const [cancelled, cancelledWithError] = buildAssistantTimeline(
			[],
			[
				executorJob('job-1', 1, { status: 'cancelled' }),
				executorJob('job-2', 2, { status: 'cancelled', error: 'stopped by user' })
			]
		);

		expect(cancelled).toMatchObject({ type: 'tool' });
		expect(cancelledWithError).toMatchObject({ type: 'tool' });
		if (cancelled?.type !== 'tool' || cancelledWithError?.type !== 'tool') {
			throw new Error('Expected tool timeline items.');
		}
		expect(assistantTimelineToolError(cancelled, true)).toBe(
			'Executor job cancelled before completion.'
		);
		expect(assistantTimelineToolError(cancelledWithError, true)).toBe('stopped by user');
		expect(assistantTimelineToolFailureKind(cancelled, true)).toBe('cancelled');
		expect(assistantTimelineToolFailureKind(cancelledWithError, true)).toBe('cancelled');
	});

	it('falls back to the failed state when a failed live job has no error', () => {
		const [failed] = buildAssistantTimeline([], [executorJob('job-1', 1, { status: 'failed' })]);

		expect(failed).toMatchObject({ type: 'tool' });
		if (failed?.type !== 'tool') throw new Error('Expected a tool timeline item.');
		expect(assistantTimelineToolError(failed, true)).toBe('Executor job failed.');
		expect(assistantTimelineToolFailureKind(failed, true)).toBe('failed');
	});

	it('labels persisted tool-result errors as failed, not cancelled', () => {
		const [tool] = buildAssistantTimeline(
			[
				{ type: 'tool-call', callId: 'call-1', name: 'exec_command', input: { cmd: 'false' } },
				{
					type: 'tool-result',
					callId: 'call-1',
					output: { error: 'command failed', status: 'failed' }
				}
			],
			[]
		);

		expect(tool).toMatchObject({ type: 'tool' });
		if (tool?.type !== 'tool') throw new Error('Expected a tool timeline item.');
		expect(assistantTimelineToolFailureKind(tool, true)).toBe('failed');
	});

	it('preserves cancelled vs failed from persisted tool-result status after jobs leave the timeline', () => {
		const [cancelled, failed] = buildAssistantTimeline(
			[
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
			],
			[]
		);

		expect(cancelled).toMatchObject({ type: 'tool' });
		expect(failed).toMatchObject({ type: 'tool' });
		if (cancelled?.type !== 'tool' || failed?.type !== 'tool') {
			throw new Error('Expected tool timeline items.');
		}
		expect(assistantTimelineToolFailureKind(cancelled, true)).toBe('cancelled');
		expect(assistantTimelineToolError(cancelled, true)).toBe('stopped by user');
		expect(assistantTimelineToolFailureKind(failed, true)).toBe('failed');
		expect(assistantTimelineToolError(failed, true)).toBe('command failed');
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

	it('starts a new group when tool type changes even if contiguous', () => {
		const blocks = groupAssistantTimeline([
			tool('c1', 'exec_command'),
			tool('c2', 'apply_patch'),
			tool('c3', 'exec_command')
		]);

		expect(blocks).toEqual([
			expect.objectContaining({
				type: 'tool-group',
				toolKey: 'exec_command',
				tools: [expect.objectContaining({ callId: 'c1' })]
			}),
			expect.objectContaining({
				type: 'tool-group',
				toolKey: 'apply_patch',
				tools: [expect.objectContaining({ callId: 'c2' })]
			}),
			expect.objectContaining({
				type: 'tool-group',
				toolKey: 'exec_command',
				tools: [expect.objectContaining({ callId: 'c3' })]
			})
		]);
	});

	it('groups by streamed name even when a matched job kind differs', () => {
		const withJob = tool('c1', 'streamed_name', {
			job: executorJob('job-1', 1, { kind: 'exec_command' })
		});
		expect(assistantTimelineToolKey(withJob)).toBe('streamed_name');

		const blocks = groupAssistantTimeline([
			withJob,
			tool('c3', 'streamed_name'),
			tool('c2', 'exec_command')
		]);

		expect(blocks).toEqual([
			expect.objectContaining({
				type: 'tool-group',
				toolKey: 'streamed_name',
				tools: [
					expect.objectContaining({ callId: 'c1' }),
					expect.objectContaining({ callId: 'c3' })
				]
			}),
			expect.objectContaining({
				type: 'tool-group',
				toolKey: 'exec_command',
				tools: [expect.objectContaining({ callId: 'c2' })]
			})
		]);
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
			key: 'reasoning::r1',
			blocks: [
				{ type: 'reasoning', id: 'r1' },
				{ type: 'tool-group', toolKey: 'exec_command' }
			]
		});
		expect(sections[1]).toMatchObject({ type: 'text', id: 't1' });
		expect(sections[2]).toMatchObject({
			type: 'work',
			key: 'reasoning::r2',
			blocks: [
				{ type: 'reasoning', id: 'r2' },
				{ type: 'tool-group', toolKey: 'apply_patch' }
			]
		});
		expect(sections[3]).toMatchObject({ type: 'text', id: 't2' });
	});

	it('distinguishes text and reasoning identities by turnId and id', () => {
		expect(assistantTimelinePartKey({ type: 'text', id: 't1', text: 'mid' })).toBe('text::t1');
		expect(
			assistantTimelinePartKey({ type: 'text', id: 't1', text: 'later', turnId: 'turn-2' })
		).toBe('text:turn-2:t1');
		expect(
			assistantTimelineWorkSectionKey({
				type: 'reasoning',
				id: 'r1',
				text: 'plan',
				turnId: 'turn-1'
			})
		).toBe('reasoning:turn-1:r1');
		expect(
			assistantTimelineWorkSectionKey({
				type: 'reasoning',
				id: 'r1',
				text: 'again',
				turnId: 'turn-2'
			})
		).toBe('reasoning:turn-2:r1');
	});

	it('keys a tools-only work section from the first tool callId', () => {
		const sections = groupAssistantTimelineSections(
			groupAssistantTimeline([tool('c1', 'exec_command'), tool('c2', 'apply_patch')])
		);

		expect(sections).toEqual([
			expect.objectContaining({
				type: 'work',
				key: 'c1',
				blocks: [
					expect.objectContaining({ type: 'tool-group', toolKey: 'exec_command' }),
					expect.objectContaining({ type: 'tool-group', toolKey: 'apply_patch' })
				]
			})
		]);
	});

	it('keeps the work-section key on the first callId after running tools settle', () => {
		const running = tool('c1', 'exec_command', {
			job: executorJob('job-1', 1, { status: 'claimed', kind: 'exec_command' })
		});
		const done = tool('c2', 'exec_command', {
			job: executorJob('job-2', 2, { status: 'completed', kind: 'exec_command' })
		});
		const sections = groupAssistantTimelineSections(groupAssistantTimeline([running, done]));
		const work = sections[0];
		if (work?.type !== 'work') throw new Error('Expected a work section.');

		const { settledBlocks } = partitionWorkSectionTools(
			work.blocks,
			true,
			buildOpenExecCommandSessions([running, done], true)
		);

		expect(work.key).toBe('c1');
		expect(settledBlocks[0]).toMatchObject({
			type: 'tool-group',
			tools: [expect.objectContaining({ callId: 'c2' })]
		});
		expect(assistantTimelineWorkSectionKey(work.blocks[0])).toBe(work.key);
	});
});

describe('partitionWorkSectionTools', () => {
	function partition(blocks: AssistantTimelineWorkBlock[], isStreaming: boolean) {
		const tools = blocks.flatMap((block) => (block.type === 'tool-group' ? block.tools : []));
		return partitionWorkSectionTools(
			blocks,
			isStreaming,
			buildOpenExecCommandSessions(tools, isStreaming)
		);
	}

	it('pulls running tools out and leaves settled reasoning/tools behind', () => {
		const blocks: AssistantTimelineWorkBlock[] = [
			{ type: 'reasoning', id: 'r1', text: 'plan' },
			{
				type: 'tool-group',
				toolKey: 'exec_command',
				tools: [
					tool('done', 'exec_command', {
						input: { cmd: 'done' },
						job: executorJob('job-done', 1, { status: 'completed', kind: 'exec_command' })
					}),
					tool('live', 'exec_command', {
						input: { cmd: 'live' },
						job: executorJob('job-live', 2, { status: 'claimed', kind: 'exec_command' })
					})
				]
			}
		];

		const { settledBlocks, runningTools } = partition(blocks, true);

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

	it('keeps yielded command sessions in Running across write_stdin monitor polls', () => {
		const blocks: AssistantTimelineWorkBlock[] = [
			{
				type: 'tool-group',
				toolKey: 'exec_command',
				tools: [
					tool('exec-1', 'exec_command', {
						input: { cmd: 'npm run dev' },
						output: { sessionId: '7', running: true },
						job: executorJob('job-exec', 1, { status: 'completed', kind: 'exec_command' })
					})
				]
			},
			{
				type: 'tool-group',
				toolKey: 'write_stdin',
				tools: [
					tool('monitor-1', 'write_stdin', {
						input: { sessionId: '7' },
						job: executorJob('job-monitor', 2, {
							status: 'claimed',
							kind: 'write_stdin',
							payload: { sessionId: '7' }
						})
					})
				]
			}
		];

		const { settledBlocks, runningTools } = partition(blocks, true);

		expect(runningTools.map((item) => item.callId)).toEqual(['exec-1']);
		expect(settledBlocks).toEqual([]);
	});

	it('moves finished command sessions out of Running after the final monitor', () => {
		const blocks: AssistantTimelineWorkBlock[] = [
			{
				type: 'tool-group',
				toolKey: 'exec_command',
				tools: [
					tool('exec-1', 'exec_command', {
						input: { cmd: 'sleep 1' },
						output: { sessionId: '3', running: true },
						job: executorJob('job-exec', 1, { status: 'completed', kind: 'exec_command' })
					})
				]
			},
			{
				type: 'tool-group',
				toolKey: 'write_stdin',
				tools: [
					tool('monitor-1', 'write_stdin', {
						input: { sessionId: '3' },
						output: { running: false },
						job: executorJob('job-monitor', 2, {
							status: 'completed',
							kind: 'write_stdin',
							payload: { sessionId: '3' }
						})
					})
				]
			}
		];

		const { settledBlocks, runningTools } = partition(blocks, true);

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

	it('closes sessions using message-wide open state across text section breaks', () => {
		const exec = tool('exec-1', 'exec_command', {
			input: { cmd: 'npm run dev' },
			output: { sessionId: '7', running: true },
			job: executorJob('job-exec', 1, { status: 'completed', kind: 'exec_command' })
		});
		const monitor = tool('monitor-1', 'write_stdin', {
			input: { sessionId: '7' },
			output: { running: false },
			job: executorJob('job-monitor', 2, {
				status: 'completed',
				kind: 'write_stdin',
				payload: { sessionId: '7' }
			})
		});
		const openSessions = buildOpenExecCommandSessions([exec, monitor], true);
		const earlierSection: AssistantTimelineWorkBlock[] = [
			{ type: 'tool-group', toolKey: 'exec_command', tools: [exec] }
		];

		const { settledBlocks, runningTools } = partitionWorkSectionTools(
			earlierSection,
			true,
			openSessions
		);

		expect(openSessions.size).toBe(0);
		expect(runningTools).toEqual([]);
		expect(settledBlocks).toEqual([
			expect.objectContaining({
				type: 'tool-group',
				tools: [expect.objectContaining({ callId: 'exec-1' })]
			})
		]);
	});

	it('settles in-flight tools and yielded commands after the run stops', () => {
		const claimedTool = tool('patch-1', 'apply_patch', {
			job: executorJob('job-patch', 1, { status: 'claimed', kind: 'apply_patch' })
		});
		const claimedToolWithResult = tool('patch-2', 'apply_patch', {
			output: { changedFiles: ['a.txt'] },
			job: executorJob('job-patch-2', 2, { status: 'claimed', kind: 'apply_patch' })
		});
		const yieldedCommand = tool('exec-1', 'exec_command', {
			input: { cmd: 'npm run dev' },
			output: { sessionId: '7', running: true },
			job: executorJob('job-exec', 3, { status: 'completed', kind: 'exec_command' })
		});
		const blocks: AssistantTimelineWorkBlock[] = [
			{ type: 'tool-group', toolKey: 'apply_patch', tools: [claimedTool, claimedToolWithResult] },
			{ type: 'tool-group', toolKey: 'exec_command', tools: [yieldedCommand] }
		];

		const { settledBlocks, runningTools } = partition(blocks, false);

		expect(runningTools).toEqual([]);
		expect(settledBlocks).toEqual(blocks);
		expect(assistantTimelineToolFailureKind(claimedTool, false)).toBe('interrupted');
		expect(assistantTimelineToolError(claimedTool, false)).toBe(
			'The agent stopped before this tool call finished.'
		);
		expect(assistantTimelineToolFailureKind(claimedToolWithResult, false)).toBeUndefined();
		expect(assistantTimelineToolFailureKind(yieldedCommand, false)).toBeUndefined();
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
});

describe('workSectionTimingAnchor', () => {
	it('treats migrated null timing as unknown rather than epoch zero', () => {
		const section = {
			type: 'work' as const,
			key: 'r1',
			blocks: [
				{ type: 'reasoning' as const, id: 'r1', text: '', startedAt: null, completedAt: null }
			]
		};
		expect(workSectionTimingAnchor(section, { inProgress: true })).toEqual({});
		expect(workSectionTimingAnchor(section, { inProgress: false, endedAt: 9_000 })).toEqual({});
	});
	it('uses recorded reasoning and tool boundaries without a job subscription', () => {
		const section = {
			type: 'work' as const,
			key: 'c1',
			blocks: [
				{ type: 'reasoning' as const, id: 'r1', text: 'plan', startedAt: 500, completedAt: 900 },
				{
					type: 'tool-group' as const,
					toolKey: 'exec_command',
					tools: [
						tool('c1', 'exec_command', {
							startedAt: 1_000,
							completedAt: 5_000
						})
					]
				},
				{
					type: 'reasoning' as const,
					id: 'r2',
					text: 'review result',
					startedAt: 5_200,
					completedAt: 7_000
				}
			]
		};

		expect(
			workSectionTimingAnchor(section, {
				inProgress: false
			})
		).toEqual({ startedAtMs: 500, completedAtMs: 7_000 });
	});

	it('does not invent a duration for old reasoning without timestamps', () => {
		const section = {
			type: 'work' as const,
			key: 'r1',
			blocks: [{ type: 'reasoning' as const, id: 'r1', text: 'thinking' }]
		};

		expect(
			workSectionTimingAnchor(section, {
				inProgress: true
			})
		).toEqual({});
		expect(workSectionTimingAnchor(section, { inProgress: false, endedAt: 9_000 })).toEqual({});
	});

	it('keeps later reasoning on its own start and freezes at the next text boundary', () => {
		const section = {
			type: 'work' as const,
			key: 'r2',
			blocks: [
				{
					type: 'reasoning' as const,
					id: 'r2',
					text: 'more',
					startedAt: 8_000,
					completedAt: 10_000
				}
			]
		};

		expect(
			workSectionTimingAnchor(section, {
				inProgress: true
			})
		).toEqual({ startedAtMs: 8_000 });
		expect(workSectionTimingAnchor(section, { inProgress: false, endedAt: 11_000 })).toEqual({
			startedAtMs: 8_000,
			completedAtMs: 11_000
		});
	});

	it('uses result completion rather than tool-call generation time', () => {
		const parts = buildAssistantTimeline(
			[
				{
					type: 'tool-call',
					callId: 'c1',
					name: 'exec_command',
					input: {},
					startedAt: 1_000,
					completedAt: 1_100
				},
				{ type: 'tool-result', callId: 'c1', output: 'done', completedAt: 5_000 }
			],
			[]
		);
		const [section] = groupAssistantTimelineSections(groupAssistantTimeline(parts));
		if (section.type !== 'work') throw new Error('Expected work');
		expect(workSectionTimingAnchor(section, { inProgress: false })).toEqual({
			startedAtMs: 1_000,
			completedAtMs: 5_000
		});
	});
});
