import { ConvexHttpClient } from 'convex/browser';

export function convexClientWithTimeout(url: string, timeoutMs: number): ConvexHttpClient {
	// Copying fetch's own members, such as Bun's `fetch.preconnect`, keeps the wrapper typed as fetch.
	const fetchWithTimeout = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) =>
			fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
		fetch
	);

	return new ConvexHttpClient(url, { fetch: fetchWithTimeout });
}
