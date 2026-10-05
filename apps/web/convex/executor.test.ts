import { describe, expect, it } from 'vitest';
import type { Infer } from 'convex/values';
import { vAskQuestionResult } from '@convex/lib/validators';
import { getRunWithExecution, patchRunExecution } from '@convex/lib/runExecution';
import { commandToolDisplayInput } from '@convex/lib/transcriptWrites';
import { api } from '@convex/_generated/api';
import {
	createQueuedRun,
	initConvexTest,
	seedOwnedThread,
	toolTranscriptAssignment,
	type ConvexTestInstance
} from './test.setup';

describe('command display inputs', () => {
	it.each(['', 'a'])('keeps bounded labels at whole code points after prefix "%s"', (prefix) => {
		const input = commandToolDisplayInput('exec_cmd', {
			cmd: `${prefix}${'😀'.repeat(10_000)}`,
			workdir: '/repo',
			chars: 'x'.repeat(500_000),
			yieldTimeMs: 0
		});

		expect(input).toEqual({
			cmd: `${prefix}${'😀'.repeat(prefix ? 4095 : 4096)}…`,
			workdir: '/repo'
		});
		expect(commandToolDisplayInput('poll_cmd', { sessionId: 'x'.repeat(500_000) })).toEqual({});
	});
});

async function seedRunWithJob(
	t: ConvexTestInstance,
	options: {
		executionSecret: string;
		runStatus?: 'queued' | 'running' | 'failed' | 'completed';
		jobStatus?: 'pending' | 'claimed' | 'completed' | 'failed' | 'cancelled';
		activeJobMatches?: boolean;
		claimId?: string;
		claimExpiresAt?: number;
	}
) {
	const executionSecret = options.executionSecret;
	const claimId = options.claimId ?? `claim-${Math.random()}`;
	const { asUser, threadId, subject } = await seedOwnedThread(t);

	const created = await createQueuedRun(
		t,
		asUser,
		threadId,
		`sub-job-${Math.random()}`,
		executionSecret,
		'Use a tool'
	);

	const jobId = await t.run(async (ctx) => {
		const section = toolTranscriptAssignment(created.runId, claimId);

		const jobId = await ctx.db.insert('executorJobs', {
			threadId,
			runId: created.runId,
			kind: 'exec_cmd',
			payload: { cmd: 'echo hi' },
			hidden: false,
			status: options.jobStatus ?? 'claimed',
			enqueuedAt: Date.now(),
			claimedAt: Date.now(),
			sequence: 0,
			...section
		});

		const otherJobId = await ctx.db.insert('executorJobs', {
			threadId,
			runId: created.runId,
			kind: 'exec_command',
			payload: { cmd: 'echo other' },
			hidden: false,
			status: 'pending',
			enqueuedAt: Date.now(),
			sequence: 1,
			...toolTranscriptAssignment(created.runId, claimId, 2)
		});

		await ctx.db.patch('runs', created.runId, {
			status: options.runStatus ?? 'running'
		});
		await patchRunExecution(ctx, created.runId, {
			claimId,
			claimExpiresAt: options.claimExpiresAt ?? Date.now() + 60_000,
			activeJobId: options.activeJobMatches === false ? otherJobId : jobId
		});

		return jobId;
	});

	return { asUser, subject, runId: created.runId, jobId, claimId, executionSecret };
}

const commandResult = {
	output: 'hi',
	exitCode: 0,
	success: true,
	running: false,
	timedOut: false,
	completeLogPath: '/transcripts/command/output.log',
	eventsPath: '/transcripts/command/events.jsonl'
};

describe('executor', () => {
	it.each(['text', 'image'] as const)(
		'persists parse_file path jobs and %s results',
		async (mode) => {
			const t = initConvexTest();
			const { asUser, threadId } = await seedOwnedThread(t);
			const executionSecret = `parse-${mode}`;
			const claimId = `claim-${mode}`;

			const { runId } = await createQueuedRun(
				t,
				asUser,
				threadId,
				`submission-${mode}`,
				executionSecret,
				'Parse this file'
			);

			await asUser.mutation(api.agentRuntime.start, { runId, claimId, executionSecret });

			const { jobId } = await asUser.mutation(api.agentRuntime.beginToolJob, {
				runId,
				claimId,
				...toolTranscriptAssignment(runId, claimId),
				executionSecret,
				kind: 'parse_file',
				callId: `call-${mode}`,
				payload: { path: '/cache/attachments/source' }
			});

			await expect(
				asUser.mutation(api.executor.complete, {
					runId,
					claimId,
					executionSecret,
					jobId,
					result:
						mode === 'text'
							? {
									outputType: 'text',
									path: '/cache/parse_file/result.md',
									source: { type: 'path', path: '/cache/attachments/source' },
									format: 'rtf',
									charCount: 5,
									preview: 'hello',
									truncated: false
								}
							: {
									outputType: 'image',
									path: '/cache/parse_file/result.png',
									source: { type: 'path', path: '/cache/attachments/source' },
									mediaType: 'image/png',
									byteSize: 123,
									width: 1,
									height: 1
								}
				})
			).resolves.toBe(true);
			const parts = await asUser.query(api.transcript.getParts, { threadId, numbers: [0, 1, 2] });
			expect(
				parts.parts.some(
					(part) => part.tool?.name === 'parse_file' && part.tool.status === 'completed'
				)
			).toBe(true);

			for (const part of parts.parts.filter((part) => part.kind === 'tool')) {
				expect(part.tool).not.toHaveProperty('input');
			}
		}
	);

	it.each(['scrape_url', 'screenshot_url'] as const)(
		'persists %s local image references without file bytes',
		async (kind) => {
			const t = initConvexTest();
			const { asUser, threadId } = await seedOwnedThread(t);
			const executionSecret = 'web-image-secret';
			const claimId = 'claim-image';

			const result = {
				outputType: 'image' as const,
				url: 'https://example.com/image',
				path: '/threads/thread/parse_file/image.png',
				mediaType: 'image/png',
				byteSize: 80,
				width: 1280,
				height: 720
			};

			const { runId } = await createQueuedRun(
				t,
				asUser,
				threadId,
				'web-image',
				executionSecret,
				'Read this image'
			);

			await asUser.mutation(api.agentRuntime.start, { runId, claimId, executionSecret });

			const { jobId } = await asUser.mutation(api.agentRuntime.beginToolJob, {
				runId,
				claimId,
				...toolTranscriptAssignment(runId, claimId),
				executionSecret,
				kind,
				payload: { url: result.url }
			});

			await expect(
				asUser.mutation(api.executor.complete, {
					runId,
					claimId,
					executionSecret,
					jobId,
					result
				})
			).resolves.toBe(true);
			const job = await t.run(async (ctx) => ctx.db.get('executorJobs', jobId));
			expect(job?.result).toEqual(result);
			const parts = await asUser.query(api.transcript.getParts, { threadId, numbers: [0, 1, 2] });
			expect(parts.parts.find((part) => part.tool?.status === 'completed')?.tool?.output).toEqual(
				result
			);
		}
	);

	it.each([
		'exec_cmd',
		'exec_command',
		'control_cmd',
		'poll_cmd',
		'control_command',
		'poll_command',
		'write_stdin'
	] as const)('persists %s jobs and flat command results without a sessionId', async (kind) => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = `command-${kind}-secret`;
		const claimId = `command-${kind}-claim`;

		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			`command-${kind}`,
			executionSecret,
			'Control the command'
		);

		await asUser.mutation(api.agentRuntime.start, { runId, claimId, executionSecret });

		const payload =
			kind === 'exec_cmd' || kind === 'exec_command'
				? { cmd: 'echo ok', workdir: '/workspace', yieldTimeMs: 0 }
				: kind === 'control_cmd' || kind === 'control_command'
					? { sessionId: '1', action: 'write' as const, chars: 'x'.repeat(500_000) }
					: kind === 'write_stdin'
						? { sessionId: '1', chars: 'x'.repeat(500_000), terminate: false }
						: { sessionId: '1', yieldTimeMs: 0 };

		const displayInput =
			kind === 'exec_cmd' || kind === 'exec_command'
				? { cmd: 'echo ok', workdir: '/workspace' }
				: kind === 'control_cmd' || kind === 'control_command'
					? { sessionId: '1', action: 'write' }
					: { sessionId: '1' };

		const { jobId } = await asUser.mutation(api.agentRuntime.beginToolJob, {
			runId,
			claimId,
			...toolTranscriptAssignment(runId, claimId),
			executionSecret,
			kind,
			callId: `call-${kind}`,
			payload
		});

		const result = {
			command: 'echo ok',
			workdir: '/',
			output: 'ok\n',
			exitCode: 0,
			success: true,
			running: false,
			timedOut: false,
			completeLogPath: '/transcripts/command/output.log',
			eventsPath: '/transcripts/command/events.jsonl'
		};

		await expect(
			asUser.mutation(api.executor.complete, {
				runId,
				claimId,
				executionSecret,
				jobId,
				result
			})
		).resolves.toBe(true);

		const job = await t.run(async (ctx) => ctx.db.get('executorJobs', jobId));
		expect(job).toMatchObject({ kind, payload, status: 'completed', result });
		expect(job?.result).not.toHaveProperty('sessionId');

		const parts = await asUser.query(api.transcript.getParts, { threadId, numbers: [0, 1, 2] });
		expect(parts.parts.filter((part) => part.tool?.name === kind).map((part) => part.tool)).toEqual(
			[
				expect.objectContaining({ status: 'started', input: displayInput, callId: `call-${kind}` }),
				expect.objectContaining({
					status: 'completed',
					input: displayInput,
					callId: `call-${kind}`
				})
			]
		);

		await t.run(async (ctx) => {
			const finished = parts.parts.find((part) => part.tool?.status === 'completed');

			if (!finished?.tool) throw new Error('Missing terminal transcript part.');
			const legacyTool = { ...finished.tool };
			delete legacyTool.input;
			await ctx.db.patch('threadTranscriptParts', finished._id, { tool: legacyTool });
		});
		await expect(
			asUser.mutation(api.executor.complete, {
				runId,
				claimId,
				executionSecret,
				jobId,
				result
			})
		).resolves.toBe(true);
		const retried = await asUser.query(api.transcript.getParts, { threadId, numbers: [2] });
		expect(retried.parts[0].tool?.input).toEqual(displayInput);
	});

	it.each([
		'exec_cmd',
		'exec_command',
		'control_cmd',
		'poll_cmd',
		'control_command',
		'poll_command',
		'write_stdin'
	] as const)('fails %s jobs', async (kind) => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = `command-${kind}-fail-secret`;
		const claimId = `command-${kind}-fail-claim`;

		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			`command-${kind}-fail`,
			executionSecret,
			'Control the command'
		);

		await asUser.mutation(api.agentRuntime.start, { runId, claimId, executionSecret });

		const payload =
			kind === 'exec_cmd' || kind === 'exec_command'
				? { cmd: 'missing-command' }
				: kind === 'control_cmd' || kind === 'control_command'
					? { sessionId: '1', action: 'terminate' as const }
					: { sessionId: '1' };

		const { jobId } = await asUser.mutation(api.agentRuntime.beginToolJob, {
			runId,
			claimId,
			...toolTranscriptAssignment(runId, claimId),
			executionSecret,
			kind,
			payload
		});

		await expect(
			asUser.mutation(api.executor.fail, {
				runId,
				claimId,
				executionSecret,
				jobId,
				error: 'unknown command session: 1'
			})
		).resolves.toBe(true);

		const job = await t.run(async (ctx) => ctx.db.get('executorJobs', jobId));
		expect(job).toMatchObject({
			kind,
			status: 'failed',
			error: 'unknown command session: 1'
		});

		const parts = await asUser.query(api.transcript.getParts, { threadId, numbers: [0, 1, 2] });
		expect(parts.parts.filter((part) => part.tool?.name === kind).map((part) => part.tool)).toEqual(
			[
				expect.objectContaining({ status: 'started', input: payload }),
				expect.objectContaining({ status: 'failed', input: payload })
			]
		);
	});

	it.each(['pending', 'answered', 'timedOut'] as const)(
		'persists compact question results for %s questions',
		async (status) => {
			const t = initConvexTest();

			for (const kind of ['ask_question', 'poll_question'] as const) {
				const { asUser, runId, jobId, claimId, executionSecret } = await seedRunWithJob(t, {
					executionSecret: `compact-question-${kind}-${status}`
				});

				const questionId = await t.run(async (ctx) => {
					const run = await ctx.db.get('runs', runId);

					if (!run) throw new Error('Run not found');

					return ctx.db.insert('agentQuestions', {
						threadId: run.threadId,
						runId,
						jobId,
						question: 'Which configuration?',
						options: [{ id: 'safe', label: 'Safe' }],
						status,
						createdAt: Date.now(),
						sequence: 1
					});
				});

				await t.run(async (ctx) => {
					await ctx.db.patch('executorJobs', jobId, {
						kind,
						status: 'claimed',
						payload:
							kind === 'ask_question'
								? { question: 'Which configuration?', options: [{ id: 'safe', label: 'Safe' }] }
								: { questionId }
					});
				});

				const result: Omit<Infer<typeof vAskQuestionResult>, 'questionId'> &
					Partial<Pick<Infer<typeof vAskQuestionResult>, 'questionId'>> = {
					pending: status === 'pending',
					timedOut: status === 'timedOut'
				};

				if (kind === 'ask_question') result.questionId = questionId;

				if (status === 'answered') result.answer = { optionId: 'safe', optionLabel: 'Safe' };

				await expect(
					asUser.mutation(api.executor.complete, { runId, claimId, executionSecret, jobId, result })
				).resolves.toBe(true);

				const stored = await t.run(async (ctx) => ctx.db.get('executorJobs', jobId));

				expect(stored?.result).toEqual(result);
			}
		}
	);

	it('completes the active job without changing the running status', async () => {
		const t = initConvexTest();

		const { asUser, runId, jobId, claimId, executionSecret } = await seedRunWithJob(t, {
			executionSecret: 'executor-complete-secret'
		});

		await expect(
			asUser.mutation(api.executor.complete, {
				jobId,
				result: commandResult,
				runId,
				claimId,
				executionSecret
			})
		).resolves.toBe(true);

		const state = await t.run(async (ctx) => ({
			job: await ctx.db.get('executorJobs', jobId),
			run: await getRunWithExecution(ctx.db, runId)
		}));

		expect(state.job).toMatchObject({
			status: 'completed',
			result: {
				output: 'hi',
				exitCode: 0,
				success: true,
				running: false,
				timedOut: false,
				completeLogPath: '/transcripts/command/output.log',
				eventsPath: '/transcripts/command/events.jsonl'
			}
		});
		expect(state.job?.completedAt).toBeTypeOf('number');
		expect(state.run?.status).toBe('running');
		expect(state.run?.activeJobId ?? undefined).toBeUndefined();
	});

	it('accepts browser tool result shapes', async () => {
		const t = initConvexTest();

		const { asUser, runId, jobId, claimId, executionSecret } = await seedRunWithJob(t, {
			executionSecret: 'executor-browser-result-secret'
		});

		const taskResult = { text: 'success: true', truncated: false };
		await expect(
			asUser.mutation(api.executor.complete, {
				jobId,
				result: taskResult,
				runId,
				claimId,
				executionSecret
			})
		).resolves.toBe(true);

		const screenshotResult = {
			mediaType: 'image/png' as const,
			dataBase64: '',
			byteLength: 123,
			truncated: false
		};

		const second = await seedRunWithJob(t, {
			executionSecret: 'executor-browser-screenshot-secret'
		});

		await expect(
			second.asUser.mutation(api.executor.complete, {
				jobId: second.jobId,
				result: screenshotResult,
				runId: second.runId,
				claimId: second.claimId,
				executionSecret: second.executionSecret
			})
		).resolves.toBe(true);
	});

	it('is idempotent for an already completed job and ignores terminal runs', async () => {
		const t = initConvexTest();

		const { asUser, runId, jobId, claimId, executionSecret } = await seedRunWithJob(t, {
			jobStatus: 'completed',
			runStatus: 'running',
			executionSecret: 'executor-idempotent-secret'
		});

		await t.run(async (ctx) => {
			await ctx.db.patch('executorJobs', jobId, { result: commandResult, completedAt: 1 });
		});

		await expect(
			asUser.mutation(api.executor.complete, {
				jobId,
				result: commandResult,
				runId,
				claimId,
				executionSecret
			})
		).resolves.toBe(true);

		const {
			asUser: asUser2,
			runId: terminalRunId,
			jobId: terminalJobId,
			claimId: terminalClaimId,
			executionSecret: terminalSecret
		} = await seedRunWithJob(t, {
			runStatus: 'completed',
			executionSecret: 'executor-terminal-secret'
		});

		await expect(
			asUser2.mutation(api.executor.complete, {
				jobId: terminalJobId,
				result: commandResult,
				runId: terminalRunId,
				claimId: terminalClaimId,
				executionSecret: terminalSecret
			})
		).resolves.toBe(false);
		expect(await t.run(async (ctx) => (await ctx.db.get('runs', terminalRunId))?.status)).toBe(
			'completed'
		);
		expect(await t.run(async (ctx) => (await ctx.db.get('runs', runId))?.status)).toBe('running');
	});

	it('fails a job and clears activeJobId only when it matches', async () => {
		const t = initConvexTest();

		const matching = await seedRunWithJob(t, {
			activeJobMatches: true,
			executionSecret: 'executor-fail-match-secret'
		});

		await expect(
			matching.asUser.mutation(api.executor.fail, {
				jobId: matching.jobId,
				error: 'boom',
				runId: matching.runId,
				claimId: matching.claimId,
				executionSecret: matching.executionSecret
			})
		).resolves.toBe(true);
		expect(
			await t.run(async (ctx) => ({
				job: await ctx.db.get('executorJobs', matching.jobId),
				run: await getRunWithExecution(ctx.db, matching.runId)
			}))
		).toMatchObject({
			job: { status: 'failed', error: 'boom' },
			run: { status: 'running' }
		});
		expect(
			(await t.run(
				async (ctx) => (await getRunWithExecution(ctx.db, matching.runId))?.activeJobId
			)) ?? undefined
		).toBeUndefined();

		const mismatched = await seedRunWithJob(t, {
			activeJobMatches: false,
			executionSecret: 'executor-fail-mismatch-secret'
		});

		const before = await t.run(async (ctx) => getRunWithExecution(ctx.db, mismatched.runId));
		await expect(
			mismatched.asUser.mutation(api.executor.fail, {
				jobId: mismatched.jobId,
				error: 'boom',
				runId: mismatched.runId,
				claimId: mismatched.claimId,
				executionSecret: mismatched.executionSecret
			})
		).resolves.toBe(true);
		const after = await t.run(async (ctx) => getRunWithExecution(ctx.db, mismatched.runId));
		expect(after?.status).toBe(before?.status);
		expect(after?.activeJobId).toBe(before?.activeJobId);
		expect(
			await t.run(async (ctx) => (await ctx.db.get('executorJobs', mismatched.jobId))?.status)
		).toBe('failed');
	});

	it('rejects tool completion and failure after the claim lease expires', async () => {
		const t = initConvexTest();

		const completeCase = await seedRunWithJob(t, {
			executionSecret: 'executor-expired-complete-secret',
			claimExpiresAt: Date.now() - 1
		});

		await expect(
			completeCase.asUser.mutation(api.executor.complete, {
				jobId: completeCase.jobId,
				result: commandResult,
				runId: completeCase.runId,
				claimId: completeCase.claimId,
				executionSecret: completeCase.executionSecret
			})
		).resolves.toBe(false);
		expect(
			await t.run(async (ctx) => ({
				jobStatus: (await ctx.db.get('executorJobs', completeCase.jobId))?.status,
				activeJobId: (await getRunWithExecution(ctx.db, completeCase.runId))?.activeJobId
			}))
		).toEqual({ jobStatus: 'claimed', activeJobId: completeCase.jobId });

		const failCase = await seedRunWithJob(t, {
			executionSecret: 'executor-expired-fail-secret',
			claimExpiresAt: Date.now() - 1
		});

		await expect(
			failCase.asUser.mutation(api.executor.fail, {
				jobId: failCase.jobId,
				error: 'late tool failure',
				runId: failCase.runId,
				claimId: failCase.claimId,
				executionSecret: failCase.executionSecret
			})
		).resolves.toBe(false);
		expect(
			await t.run(async (ctx) => ({
				jobStatus: (await ctx.db.get('executorJobs', failCase.jobId))?.status,
				activeJobId: (await getRunWithExecution(ctx.db, failCase.runId))?.activeJobId
			}))
		).toEqual({ jobStatus: 'claimed', activeJobId: failCase.jobId });
	});

	it('stores mandate_charge handles without payment credentials', async () => {
		const t = initConvexTest();
		const { asUser, runId, jobId, claimId, executionSecret, subject } = await seedRunWithJob(t, {
			executionSecret: 'mandate-charge-secret'
		});

		const chargeId = await t.run(async (ctx) => {
			const mandateId = await ctx.db.insert('mandates', {
				userId: subject,
				pravaSessionId: 'session',
				amountCap: 100,
				currency: 'USD',
				frequency: 'one_time',
				scope: 'any',
				status: 'active',
				description: 'Test purchase',
				approvalUrl: 'https://example.test/approve',
				createdAt: Date.now(),
				updatedAt: Date.now()
			});

			await ctx.db.patch('executorJobs', jobId, {
				kind: 'mandate_charge',
				payload: {
					mandateId,
					amount: '1.00',
					currency: 'USD',
					description: 'Test purchase'
				}
			});

			return await ctx.db.insert('mandateCharges', {
				mandateId,
				runId,
				userId: subject,
				pravaTransactionId: 'txn_live',
				amount: 100,
				currency: 'USD',
				description: 'Test purchase',
				status: 'awaiting_result',
				createdAt: Date.now(),
				updatedAt: Date.now()
			});
		});

		const result = {
			chargeId,
			transactionId: 'txn_live',
			token: 'tok_live',
			dynamicCvv: '737',
			expiryMonth: '12',
			expiryYear: '2030'
		};

		await expect(
			asUser.mutation(api.executor.complete, {
				jobId,
				result,
				runId,
				claimId,
				executionSecret
			})
		).resolves.toBe(true);

		const stored = await t.run(async (ctx) => ctx.db.get('executorJobs', jobId));

		expect(stored).toMatchObject({
			status: 'completed',
			result: { chargeId, transactionId: 'txn_live' }
		});
		expect(stored?.result).not.toHaveProperty('token');
		expect(stored?.result).not.toHaveProperty('dynamicCvv');
		expect(JSON.stringify(stored?.result)).not.toContain('tok_live');
		expect(JSON.stringify(stored?.result)).not.toContain('737');

		const run = await t.run(async (ctx) => ctx.db.get('runs', runId));

		if (!run) throw new Error('Run not found');

		const parts = await asUser.query(api.transcript.getParts, {
			threadId: run.threadId,
			numbers: [0, 1, 2, 3, 4]
		});
		const chargePart = parts.parts.find((part) => part.tool?.name === 'mandate_charge');

		expect(chargePart?.tool?.output).toEqual({ chargeId, transactionId: 'txn_live' });
		expect(JSON.stringify(chargePart)).not.toContain('tok_live');
		expect(JSON.stringify(chargePart)).not.toContain('737');
	});
});
