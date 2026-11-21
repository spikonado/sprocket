import { ConvexHttpClient } from 'convex/browser';

export class NetworkError extends Error {}

export function fetchWithTimeout(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	timeoutMs: number
): Promise<Response> {
	return fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }).catch((cause) => {
		throw new NetworkError('Could not reach Sprocket. Check your connection.', { cause });
	});
}

export function convexClientWithTimeout(url: string, timeoutMs: number): ConvexHttpClient {
	// Copying fetch's own members, such as Bun's `fetch.preconnect`, keeps the wrapper typed as fetch.
	const timedFetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => fetchWithTimeout(input, init, timeoutMs),
		fetch
	);

	return new ConvexHttpClient(url, { fetch: timedFetch });
}
