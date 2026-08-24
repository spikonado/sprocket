import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APICallError } from 'ai';
import { ConvexError } from 'convex/values';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { COMPLETION_STREAM_SUPERSEDED } from '@convex/lib/completionStream';
import { toModelCompletionConvexError } from '@convex/lib/agentErrors';
import { bindCompletionModelFns } from './completion';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';

const streamTextMock = vi.fn();
const generateTextMock = vi.fn();

function emptyCompletionStream() {
	return (async function* () {})();
}

function rejected<T>(promise: Promise<T>): Promise<T> {
	promise.catch(() => {});
	return promise;
}

function streamTextFailure(error: Error) {
	const rejection = rejected(Promise.reject(error));
	return {
		stream: emptyCompletionStream(),
		text: rejection,
		usage: rejection,
		finalStep: rejection,
		toolCalls: rejection
	};
}

async function startClaimedRun(
	t: ReturnType<typeof initConvexTest>,
	asUser: Awaited<ReturnType<typeof seedOwnedThread>>['asUser'],
	threadId: Id<'threadRecords'>
) {
	const executionSecret = 'completion-secret';
	const created = await createQueuedRun(asUser, threadId, 'sub-completion', executionSecret);
	await t.mutation(api.agentRuntime.start, {
		runId: created.runId,
		claimId: 'claim-completion',
		executionSecret
	});
	return { runId: created.runId, executionSecret };
}

function completeArgs(runId: Id<'runs'>, executionSecret: string) {
	return {
		modelId: 'gpt-5.6-sol' as const,
		prompt: 'Hello',
		streamRunId: runId,
		claimId: 'claim-completion',
		attemptSeq: 1,
		streamId: 'stream-completion',
		executionSecret
	};
}

describe('completion.complete', () => {
	let restoreCompletionModelFns: () => void;

	beforeEach(() => {
		streamTextMock.mockReset();
		generateTextMock.mockReset();
		restoreCompletionModelFns = bindCompletionModelFns({
			streamText: streamTextMock,
			generateText: generateTextMock
		});
	});

	afterEach(() => {
		restoreCompletionModelFns();
	});

	it(
		'surfaces provider billing errors instead of masking them as Server Error',
		{ timeout: 15_000 },
		async () => {
			const t = initConvexTest();
			const { asUser, threadId } = await seedOwnedThread(t);
			const { runId, executionSecret } = await startClaimedRun(t, asUser, threadId);
			streamTextMock.mockReturnValue(
				streamTextFailure(
					new APICallError({
						message: 'You exceeded your current quota, please check your plan and billing details.',
						url: 'https://api.openai.com/v1/responses',
						requestBodyValues: {},
						statusCode: 429,
						responseBody: JSON.stringify({
							error: {
								message:
									'You exceeded your current quota, please check your plan and billing details.',
								type: 'insufficient_quota',
								code: 'insufficient_quota'
							}
						})
					})
				)
			);

			const failure = await t
				.action(api.completion.complete, completeArgs(runId, executionSecret))
				.then(
					() => {
						throw new Error('expected the completion action to fail');
					},
					(error) => error
				);
			expect(failure).toBeInstanceOf(ConvexError);
			if (!(failure instanceof Error)) throw new Error('expected Error');
			expect(failure.message).toContain('exceeded your current quota');
		}
	);

	it('reports provider 5xx failures with their status code', { timeout: 15_000 }, async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const { runId, executionSecret } = await startClaimedRun(t, asUser, threadId);
		streamTextMock.mockReturnValue(
			streamTextFailure(
				new APICallError({
					message: 'Bad Gateway',
					url: 'https://api.openai.com/v1/responses',
					requestBodyValues: {},
					statusCode: 502
				})
			)
		);

		const failure = await t
			.action(api.completion.complete, completeArgs(runId, executionSecret))
			.then(
				() => {
					throw new Error('expected the completion action to fail');
				},
				(error) => {
					if (!(error instanceof Error)) throw new Error('expected Error');
					return error;
				}
			);
		expect(failure).toBeInstanceOf(ConvexError);
		expect(failure.message).toContain('HTTP 502');
		expect(failure.message).toContain('Bad Gateway');
	});

	it('keeps control-flow errors readable for the executor', { timeout: 15_000 }, async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const { runId, executionSecret } = await startClaimedRun(t, asUser, threadId);
		streamTextMock.mockReturnValue(streamTextFailure(new Error(COMPLETION_STREAM_SUPERSEDED)));

		const failure = await t
			.action(api.completion.complete, completeArgs(runId, executionSecret))
			.then(
				() => {
					throw new Error('expected the completion action to fail');
				},
				(error) => {
					if (!(error instanceof Error)) throw new Error('expected Error');
					return error;
				}
			);
		expect(failure.message).toContain(COMPLETION_STREAM_SUPERSEDED);
	});

	it(
		'rejects a superseded attempt registration with the sentinel text',
		{ timeout: 15_000 },
		async () => {
			const t = initConvexTest();
			const { asUser, threadId } = await seedOwnedThread(t);
			const { runId, executionSecret } = await startClaimedRun(t, asUser, threadId);
			await t.run(async (ctx) => {
				await ctx.db.patch(runId, { completionAttemptSeq: 9 });
			});

			// registerCompletionAttempt throws before the model is called.
			const failure = await t
				.action(api.completion.complete, completeArgs(runId, executionSecret))
				.then(
					() => {
						throw new Error('expected the completion action to fail');
					},
					(error) => {
						if (!(error instanceof Error)) throw new Error('expected Error');
						return error;
					}
				);
			expect(failure).toBeInstanceOf(ConvexError);
			expect(failure.message).toBe(COMPLETION_STREAM_SUPERSEDED);
		}
	);

	it('rejects a cancelled run with the cancellation sentinel', { timeout: 15_000 }, async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const { runId, executionSecret } = await startClaimedRun(t, asUser, threadId);
		await t.run(async (ctx) => {
			await ctx.db.patch(runId, { status: 'cancelled' });
		});

		const failure = await t
			.action(api.completion.complete, completeArgs(runId, executionSecret))
			.then(
				() => {
					throw new Error('expected the completion action to fail');
				},
				(error) => {
					if (!(error instanceof Error)) throw new Error('expected Error');
					return error;
				}
			);
		expect(failure).toBeInstanceOf(ConvexError);
		expect(failure.message).toBe('Run is cancelled.');
	});
});

describe('completion.summarize', () => {
	let restoreCompletionModelFns: () => void;

	beforeEach(() => {
		generateTextMock.mockReset();
		restoreCompletionModelFns = bindCompletionModelFns({
			streamText: streamTextMock,
			generateText: generateTextMock
		});
	});

	afterEach(() => {
		restoreCompletionModelFns();
	});

	it('surfaces provider billing errors from context compaction', { timeout: 15_000 }, async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const { runId, executionSecret } = await startClaimedRun(t, asUser, threadId);
		generateTextMock.mockRejectedValue(
			new APICallError({
				message: 'You exceeded your current quota, please check your plan and billing details.',
				url: 'https://api.openai.com/v1/responses',
				requestBodyValues: {},
				statusCode: 429,
				responseBody: JSON.stringify({
					error: {
						message: 'You exceeded your current quota, please check your plan and billing details.',
						type: 'insufficient_quota',
						code: 'insufficient_quota'
					}
				})
			})
		);

		const failure = await t
			.action(api.completion.summarize, {
				modelId: 'gpt-5.6-sol',
				messagesJson: JSON.stringify([{ role: 'user', content: 'Summarize this.' }]),
				runId,
				claimId: 'claim-completion',
				executionSecret
			})
			.then(
				() => {
					throw new Error('expected the summarize action to fail');
				},
				(error) => {
					if (!(error instanceof Error)) throw new Error('expected Error');
					return error;
				}
			);
		expect(failure).toBeInstanceOf(ConvexError);
		expect(failure.message).toContain('exceeded your current quota');
	});
});

describe('toModelCompletionConvexError', () => {
	it('passes through cancellation and lease-loss control flow unchanged', () => {
		const cancelled = new Error('Run is cancelled.');
		expect(toModelCompletionConvexError(cancelled, 'gpt-5.6-sol')).toBe(cancelled);
		const inactive = new Error('Run is no longer active.');
		expect(toModelCompletionConvexError(inactive, 'gpt-5.6-sol')).toBe(inactive);
		const superseded = new Error(COMPLETION_STREAM_SUPERSEDED);
		expect(toModelCompletionConvexError(superseded, 'gpt-5.6-sol')).toBe(superseded);
	});

	it('strips the Convex uncaught-error prefix from the stored message', () => {
		const error = new Error('Uncaught Error: kaboom\n\tat handler (../convex/completion.ts:1:1)');
		expect(toModelCompletionConvexError(error, 'gpt-5.6-sol').message).toBe(
			'The model provider failed: kaboom'
		);
	});

	it('detects billing failures from the AI SDK retry chain', () => {
		const quota = new APICallError({
			message: 'You exceeded your current quota, please check your plan and billing details.',
			url: 'https://api.openai.com/v1/responses',
			requestBodyValues: {},
			statusCode: 429,
			data: { error: { code: 'insufficient_quota' } }
		});
		const wrapped = new Error('RetryError: failed after retries', { cause: quota });
		const converted = toModelCompletionConvexError(wrapped, 'gpt-5.6-sol');
		expect(converted).toBeInstanceOf(ConvexError);
		expect(converted.message).toBe(
			'The model provider rejected the request: You exceeded your current quota, please check your plan and billing details.'
		);
	});

	it('keeps provider key material out of auth failures', () => {
		const rejected = new APICallError({
			message: 'Incorrect API key provided: sk-live-...redacted',
			url: 'https://api.openai.com/v1/responses',
			requestBodyValues: {},
			statusCode: 401,
			responseBody: JSON.stringify({
				error: {
					message: 'Incorrect API key provided: sk-live-...redacted',
					code: 'invalid_api_key'
				}
			})
		});
		const converted = toModelCompletionConvexError(rejected, 'gpt-5.6-sol');
		expect(converted.message).toBe(
			'The model provider rejected the API key. Check the provider API key configuration.'
		);
	});

	it('prefers the innermost provider message over retry wrapper text', () => {
		const badGateway = new APICallError({
			message: 'Bad Gateway',
			url: 'https://api.openai.com/v1/responses',
			requestBodyValues: {},
			statusCode: 502
		});
		const wrapped = new Error('RetryError: failed after 5 retries', { cause: badGateway });
		expect(toModelCompletionConvexError(wrapped, 'gpt-5.6-sol').message).toBe(
			'The model provider returned a server error (HTTP 502) while running gpt-5.6-sol: Bad Gateway'
		);
	});
});
