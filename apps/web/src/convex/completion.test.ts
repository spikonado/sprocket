import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APICallError } from 'ai';
import { ConvexError } from 'convex/values';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { COMPLETION_STREAM_SUPERSEDED } from '@convex/lib/completionStream';
import { toModelCompletionConvexError } from '@convex/lib/agentErrors';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';

const streamTextMock = vi.hoisted(() => vi.fn());
const generateTextMock = vi.hoisted(() => vi.fn());

vi.mock('ai', async (importOriginal) => {
	const actual = await importOriginal<typeof import('ai')>();
	return { ...actual, streamText: streamTextMock, generateText: generateTextMock };
});

function emptyCompletionStream() {
	return (async function* () {})();
}

function rejected<T>(promise: Promise<T>): Promise<T> {
	promise.catch(() => {});
	return promise;
}

function streamTextFailure(error: unknown) {
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
	beforeEach(() => {
		streamTextMock.mockReset();
	});

	it('surfaces provider billing errors instead of masking them as Server Error', async () => {
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
				(error: unknown) => error
			);
		expect(failure).toBeInstanceOf(ConvexError);
		expect((failure as Error).message).toContain('exceeded your current quota');
	});

	it('reports provider 5xx failures with their status code', async () => {
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
				(error: unknown) => error
			);
		expect(failure).toBeInstanceOf(ConvexError);
		expect((failure as Error).message).toContain('HTTP 502');
		expect((failure as Error).message).toContain('Bad Gateway');
	});

	it('keeps control-flow errors as plain errors for the executor', async () => {
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
				(error: unknown) => error
			);
		expect((failure as Error).message).toContain(COMPLETION_STREAM_SUPERSEDED);
	});
});

describe('completion.summarize', () => {
	beforeEach(() => {
		generateTextMock.mockReset();
	});

	it('surfaces provider billing errors from context compaction', async () => {
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
				(error: unknown) => error
			);
		expect(failure).toBeInstanceOf(ConvexError);
		expect((failure as Error).message).toContain('exceeded your current quota');
	});
});

describe('toModelCompletionConvexError', () => {
	const context = { modelId: 'gpt-5.6-sol', serviceTier: 'standard' };

	it('passes through cancellation and lease-loss control flow unchanged', () => {
		const cancelled = new Error('Run is cancelled.');
		expect(toModelCompletionConvexError(cancelled, context)).toBe(cancelled);
		const inactive = new Error('Run is no longer active.');
		expect(toModelCompletionConvexError(inactive, context)).toBe(inactive);
		const superseded = new Error(COMPLETION_STREAM_SUPERSEDED);
		expect(toModelCompletionConvexError(superseded, context)).toBe(superseded);
	});

	it('strips the Convex uncaught-error prefix before classifying', () => {
		const error = new Error(
			`Uncaught Error: ${COMPLETION_STREAM_SUPERSEDED}\n\tat handler (../convex/completion.ts:1:1)`
		);
		expect(toModelCompletionConvexError(error, context)).toBe(error);
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
		const converted = toModelCompletionConvexError(wrapped, context);
		expect(converted).toBeInstanceOf(ConvexError);
		expect(converted.message).toContain('billing');
	});
});
