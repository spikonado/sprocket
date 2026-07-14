import { describe, expect, it } from 'vitest';
import { advanceConvexAuthRetryPending } from '$lib/authRetry';

describe('advanceConvexAuthRetryPending', () => {
	it('resets the saw-loading latch when retry is not pending', () => {
		expect(
			advanceConvexAuthRetryPending({
				retryPending: false,
				isAuthenticated: false,
				isLoading: false,
				sawLoadingDuringRetry: true
			})
		).toEqual({ clearPending: false, sawLoadingDuringRetry: false });
	});

	it('keeps pending across the gap before Convex reports loading', () => {
		expect(
			advanceConvexAuthRetryPending({
				retryPending: true,
				isAuthenticated: false,
				isLoading: false,
				sawLoadingDuringRetry: false
			})
		).toEqual({ clearPending: false, sawLoadingDuringRetry: false });
	});

	it('records Convex loading and clears only after a settled failure', () => {
		expect(
			advanceConvexAuthRetryPending({
				retryPending: true,
				isAuthenticated: false,
				isLoading: true,
				sawLoadingDuringRetry: false
			})
		).toEqual({ clearPending: false, sawLoadingDuringRetry: true });

		expect(
			advanceConvexAuthRetryPending({
				retryPending: true,
				isAuthenticated: false,
				isLoading: false,
				sawLoadingDuringRetry: true
			})
		).toEqual({ clearPending: true, sawLoadingDuringRetry: true });
	});

	it('clears pending as soon as Convex authenticates', () => {
		expect(
			advanceConvexAuthRetryPending({
				retryPending: true,
				isAuthenticated: true,
				isLoading: false,
				sawLoadingDuringRetry: false
			})
		).toEqual({ clearPending: true, sawLoadingDuringRetry: false });
	});
});
