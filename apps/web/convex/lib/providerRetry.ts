const BACKOFF_BASE_MS = 1_000;

const BACKOFF_MAX_MS = 16_000;

/** Below this, another attempt cannot finish useful work. */
const MIN_ATTEMPT_MS = 5_000;

/**
 * Retries rate-limited calls with jittered backoff until `deadline`. Each
 * attempt gets the remaining time, capped at `maxAttemptMs`. `retryAfterMs`
 * returns the provider's wait for a rate-limit error and `undefined` for any
 * other error, which `failure` maps and throws at once. `shouldContinue` runs
 * after each wait so cancelled work stops calling the provider.
 */
export async function retryRateLimited<T>(options: {
	deadline: number;
	maxAttemptMs: number;
	attempt: (timeoutMs: number) => Promise<T>;
	retryAfterMs: (error: Error) => number | undefined;
	failure: (error: Error) => Error;
	shouldContinue: () => Promise<boolean>;
}): Promise<T> {
	for (let retry = 0; ; retry++) {
		const timeoutMs = Math.min(options.maxAttemptMs, options.deadline - Date.now());

		try {
			return await options.attempt(Math.max(timeoutMs, 1));
		} catch (caught) {
			const error =
				caught instanceof Error ? caught : new Error('Provider request failed.', { cause: caught });

			const retryAfter = options.retryAfterMs(error);

			if (retryAfter === undefined) throw options.failure(error);

			const backoff = Math.min(BACKOFF_BASE_MS * 2 ** retry, BACKOFF_MAX_MS);
			const delay = Math.max(retryAfter, backoff / 2) + Math.random() * (backoff / 2);

			if (Date.now() + delay + MIN_ATTEMPT_MS > options.deadline) throw options.failure(error);

			await new Promise((resolve) => setTimeout(resolve, delay));

			if (!(await options.shouldContinue())) throw options.failure(error);
		}
	}
}
