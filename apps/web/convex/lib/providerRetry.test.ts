import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { retryAfterHeaderMs, retryRateLimited } from '@convex/lib/providerRetry';

class RateLimited extends Error {}

function retryOptions(
	deadlineInMs: number,
	attempt: (timeoutMs: number) => Promise<string>,
	shouldContinue = async () => true
) {
	return {
		deadline: Date.now() + deadlineInMs,
		maxAttemptMs: 60_000,
		attempt,
		retryAfterMs: (error: Error) => (error instanceof RateLimited ? 0 : undefined),
		failure: (error: Error) => new Error(`mapped: ${error.message}`),
		shouldContinue
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('retryRateLimited', () => {
	it('retries a rate limit with the remaining time as the attempt timeout', async () => {
		const attempt = vi
			.fn<(timeoutMs: number) => Promise<string>>()
			.mockRejectedValueOnce(new RateLimited('slow down'))
			.mockResolvedValueOnce('done');

		const result = retryRateLimited(retryOptions(20_000, attempt));

		await vi.advanceTimersByTimeAsync(500);
		expect(await result).toBe('done');
		expect(attempt.mock.calls).toEqual([[20_000], [19_500]]);
	});

	it('maps a rate limit once no useful attempt fits before the deadline', async () => {
		const attempt = vi.fn(async () => {
			throw new RateLimited('slow down');
		});

		await expect(retryRateLimited(retryOptions(5_400, attempt))).rejects.toThrow(
			'mapped: slow down'
		);
		expect(attempt).toHaveBeenCalledTimes(1);
	});

	it('stops retrying once the work is no longer wanted', async () => {
		const attempt = vi.fn(async () => {
			throw new RateLimited('slow down');
		});

		const result = retryRateLimited(retryOptions(60_000, attempt, async () => false));
		const settled = expect(result).rejects.toThrow('mapped: slow down');

		await vi.advanceTimersByTimeAsync(500);
		await settled;
		expect(attempt).toHaveBeenCalledTimes(1);
	});

	it('maps other errors without retrying', async () => {
		const attempt = vi.fn(async () => {
			throw new Error('bad request');
		});

		await expect(retryRateLimited(retryOptions(60_000, attempt))).rejects.toThrow(
			'mapped: bad request'
		);
		expect(attempt).toHaveBeenCalledTimes(1);
	});
});

describe('retryAfterHeaderMs', () => {
	it('reads delay seconds and HTTP dates', () => {
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

		expect(retryAfterHeaderMs('3')).toBe(3_000);
		expect(retryAfterHeaderMs('Thu, 01 Jan 2026 00:00:10 GMT')).toBe(10_000);
		expect(retryAfterHeaderMs(null)).toBe(0);
	});
});
