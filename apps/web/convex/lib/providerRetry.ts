const BACKOFF_BASE_MS = 1_000;

const BACKOFF_MAX_MS = 16_000;

const MIN_ATTEMPT_MS = 5_000;

export async function retryRateLimited<T>(options: {
	deadline: number;
	maxAttemptMs: number;
	attempt: (timeoutMs: number) => Promise<T>;
	rateLimitWaitMs: (error: Error) => number | undefined;
	finalError: (error: Error) => Error;
	shouldContinue: () => Promise<boolean>;
}): Promise<T> {
	for (let retry = 0; ; retry++) {
		const timeoutMs = Math.min(options.maxAttemptMs, options.deadline - Date.now());

		try {
			return await options.attempt(Math.max(timeoutMs, 1));
		} catch (caught) {
			const error =
				caught instanceof Error ? caught : new Error('Provider request failed.', { cause: caught });

			const retryAfter = options.rateLimitWaitMs(error);

			if (retryAfter === undefined) throw options.finalError(error);

			const backoff = Math.min(BACKOFF_BASE_MS * 2 ** retry, BACKOFF_MAX_MS);
			const delay = Math.max(retryAfter, backoff / 2) + Math.random() * (backoff / 2);

			if (Date.now() + delay + MIN_ATTEMPT_MS > options.deadline) throw options.finalError(error);

			await new Promise((resolve) => setTimeout(resolve, delay));

			if (!(await options.shouldContinue())) throw options.finalError(error);
		}
	}
}

export function retryAfterHeaderMs(value: string | null | undefined): number {
	if (!value) return 0;

	const seconds = Number(value);

	const ms = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - Date.now();

	return Number.isFinite(ms) && ms > 0 ? ms : 0;
}
