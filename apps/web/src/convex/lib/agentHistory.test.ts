import { describe, expect, it } from 'vitest';
import {
	buildAgentHistoryFromAssistantParts,
	buildCanonicalAgentHistory
} from '@convex/lib/agentHistory';
import { cancelExecutorJobsForTerminalRun } from '@convex/lib/runs';

describe('canonical agent history', () => {
	it('groups parallel calls from one model turn before their grouped results', () => {
		const history = buildAgentHistoryFromAssistantParts({
			parts: [
				{
					type: 'tool-call',
					callId: 'call-1',
					name: 'exec_command',
					input: { cmd: 'one' },
					turnId: 'turn-1'
				},
				{ type: 'tool-result', callId: 'call-1', output: 'one' },
				{
					type: 'tool-call',
					callId: 'call-2',
					name: 'exec_command',
					input: { cmd: 'two' },
					turnId: 'turn-1'
				},
				{ type: 'tool-result', callId: 'call-2', output: 'two' }
			],
			jobs: [],
			fallbackText: ''
		});

		expect(history.map((message) => message.role)).toEqual(['assistant', 'user']);
		expect(history[0]?.contents).toMatchObject([
			{ type: 'toolCall', callId: 'call-1' },
			{ type: 'toolCall', callId: 'call-2' }
		]);
		expect(history[1]?.contents).toMatchObject([
			{ type: 'toolResult', callId: 'call-1' },
			{ type: 'toolResult', callId: 'call-2' }
		]);
	});

	it('starts a new inferred turn for an untagged call after tool results', () => {
		const history = buildAgentHistoryFromAssistantParts({
			parts: [
				{
					type: 'tool-call',
					callId: 'call-1',
					name: 'exec_command',
					input: { cmd: 'one' }
				},
				{ type: 'tool-result', callId: 'call-1', output: 'one' },
				{
					type: 'tool-call',
					callId: 'call-2',
					name: 'exec_command',
					input: { cmd: 'two' }
				},
				{ type: 'tool-result', callId: 'call-2', output: 'two' }
			],
			jobs: [],
			fallbackText: ''
		});

		expect(history.map((message) => message.role)).toEqual([
			'assistant',
			'user',
			'assistant',
			'user'
		]);
		expect(history[0]?.contents).toMatchObject([{ type: 'toolCall', callId: 'call-1' }]);
		expect(history[2]?.contents).toMatchObject([{ type: 'toolCall', callId: 'call-2' }]);
	});

	it('keeps ambiguous same-name jobs before text from the following model turn', () => {
		const history = buildAgentHistoryFromAssistantParts({
			parts: [
				{
					type: 'tool-call',
					callId: 'provider-call-1',
					name: 'exec_command',
					input: { cmd: 'same' },
					turnId: 'tool-turn'
				},
				{
					type: 'tool-call',
					callId: 'provider-call-2',
					name: 'exec_command',
					input: { cmd: 'same' },
					turnId: 'tool-turn'
				},
				{ type: 'text', id: 'answer', text: 'After tools', turnId: 'answer-turn' }
			],
			jobs: [
				{
					id: 'job-1',
					kind: 'exec_command',
					payload: { cmd: 'same' },
					status: 'completed',
					result: 'first'
				},
				{
					id: 'job-2',
					kind: 'exec_command',
					payload: { cmd: 'same' },
					status: 'completed',
					result: 'second'
				}
			],
			fallbackText: ''
		});

		expect(history.map((message) => message.role)).toEqual(['assistant', 'user', 'assistant']);
		expect(history[0]?.contents).toMatchObject([
			{ type: 'toolCall', callId: 'executor-job:job-1' },
			{ type: 'toolCall', callId: 'executor-job:job-2' }
		]);
		expect(history[1]?.contents).toMatchObject([
			{ type: 'toolResult', callId: 'executor-job:job-1' },
			{ type: 'toolResult', callId: 'executor-job:job-2' }
		]);
		expect(history[2]?.contents).toEqual([{ type: 'text', text: 'After tools' }]);
	});

	it('replays cancelled sibling jobs as tool results after terminal reconciliation', () => {
		const jobs = cancelExecutorJobsForTerminalRun({
			jobs: [
				{
					id: 'job-1',
					kind: 'exec_command' as const,
					payload: { cmd: 'one' },
					status: 'claimed' as const
				},
				{
					id: 'job-2',
					kind: 'exec_command' as const,
					payload: { cmd: 'two' },
					status: 'pending' as const
				}
			],
			runStatus: 'failed',
			lastError: 'model failed',
			completedAt: 42
		});
		const history = buildAgentHistoryFromAssistantParts({
			parts: [
				{
					type: 'tool-call',
					callId: 'call-1',
					name: 'exec_command',
					input: { cmd: 'one' },
					turnId: 'tool-turn'
				},
				{
					type: 'tool-call',
					callId: 'call-2',
					name: 'exec_command',
					input: { cmd: 'two' },
					turnId: 'tool-turn'
				}
			],
			jobs,
			fallbackText: ''
		});

		expect(history.map((message) => message.role)).toEqual(['assistant', 'user']);
		expect(history[1]?.contents).toMatchObject([
			{
				type: 'toolResult',
				callId: 'call-1',
				items: [{ text: JSON.stringify({ error: 'model failed', status: 'cancelled' }) }]
			},
			{
				type: 'toolResult',
				callId: 'call-2',
				items: [{ text: JSON.stringify({ error: 'model failed', status: 'cancelled' }) }]
			}
		]);
	});

	it('preserves assistant text provider metadata in the canonical wire format', () => {
		const history = buildAgentHistoryFromAssistantParts({
			parts: [
				{
					type: 'text',
					id: 'text-1',
					text: 'Hello',
					providerMetadata: { openai: { itemId: 'msg_123' } }
				}
			],
			jobs: [],
			fallbackText: ''
		});

		expect(history).toEqual([
			{
				role: 'assistant',
				contents: [
					{
						type: 'text',
						text: 'Hello',
						additionalParamsJson: JSON.stringify({ openai: { itemId: 'msg_123' } })
					}
				]
			}
		]);
	});

	it.each(['failed', 'cancelled'] as const)(
		'reconciles persisted tool parts for a %s run without losing metadata or order',
		(runStatus) => {
			const runId = `${runStatus}-run`;
			const callId = `${runStatus}-call`;
			const history = buildCanonicalAgentHistory({
				messages: [
					{
						type: 'response',
						runId,
						runStatus,
						text: '',
						parts: [
							{
								type: 'tool-call',
								callId,
								name: 'exec_command',
								input: { cmd: runStatus },
								turnId: `${runStatus}-turn`,
								providerMetadata: { openai: { itemId: `${runStatus}-item` } }
							},
							{ type: 'tool-result', callId, output: { persisted: runStatus } },
							{
								type: 'text',
								id: `${runStatus}-text`,
								text: 'after result',
								turnId: `${runStatus}-next-turn`
							}
						]
					}
				] as unknown as Parameters<typeof buildCanonicalAgentHistory>[0]['messages'],
				jobs: [
					{
						_id: `${runStatus}-job`,
						runId,
						callId,
						kind: 'exec_command',
						payload: { cmd: runStatus },
						status: runStatus,
						sequence: 0
					}
				] as unknown as Parameters<typeof buildCanonicalAgentHistory>[0]['jobs']
			});

			expect(history.map((message) => message.role)).toEqual(['assistant', 'user', 'assistant']);
			expect(history[0]?.contents).toEqual([
				{
					type: 'toolCall',
					id: callId,
					callId,
					name: 'exec_command',
					argumentsJson: JSON.stringify({ cmd: runStatus }),
					additionalParamsJson: JSON.stringify({
						openai: { itemId: `${runStatus}-item` }
					})
				}
			]);
			expect(history[1]?.contents).toMatchObject([{ type: 'toolResult', callId }]);
			expect(history[2]?.contents).toEqual([{ type: 'text', text: 'after result' }]);
		}
	);
});
