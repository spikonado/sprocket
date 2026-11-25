import { describe, expect, it } from 'vitest';
import { isNonRetryableError } from '@convex-dev/workpool';
import { classifyExaSearchFailure } from '@convex/webTools';

describe('Exa search failures', () => {
	it.each([400, 401, 402, 403])('does not retry HTTP %i', (status) => {
		const cause = new Error(
			`Uncaught Error: Exa /search failed (${status}): provider rejected the request`
		);

		const error = classifyExaSearchFailure(cause);

		expect(isNonRetryableError(error)).toBe(true);
		expect(error.message).toContain(`Exa search failed (${status}): provider rejected the request`);
	});

	it.each([408, 425, 429, 500, 503, 504])('retries transient HTTP %i', (status) => {
		const failure = new Error(`Exa /search failed (${status}): transient`);
		const error = classifyExaSearchFailure(failure);

		expect(error).toBe(failure);
		expect(isNonRetryableError(error)).toBe(false);
	});

	it('does not retry a missing API key', () => {
		const error = classifyExaSearchFailure(new Error('Missing EXA_API_KEY for the Exa component.'));
		expect(isNonRetryableError(error)).toBe(true);
	});

	it('preserves transport failures for retry', () => {
		const failure = new Error('fetch failed');
		expect(classifyExaSearchFailure(failure)).toBe(failure);
	});
});
