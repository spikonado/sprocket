import { waitUntil } from '@vercel/functions';
import { PUBLIC_POSTHOG_KEY } from 'astro:env/client';
import { PostHog } from 'posthog-node';

const POSTHOG_KEY = PUBLIC_POSTHOG_KEY?.trim();

let client: PostHog | undefined;

function posthog(): PostHog | undefined {
	if (POSTHOG_KEY) client ??= new PostHog(POSTHOG_KEY, { host: 'https://eu.i.posthog.com' });

	return client;
}

/** The browser SDK adds these headers to same-origin requests through `tracing_headers`. */
function browserIds(request: Request) {
	return {
		distinctId: request.headers.get('X-POSTHOG-DISTINCT-ID')?.trim() || undefined,
		sessionId: request.headers.get('X-POSTHOG-SESSION-ID')?.trim() || undefined
	};
}

function sendLater(send: Promise<void>): void {
	waitUntil(send.catch(() => {}));
}

export function captureServerException(cause: unknown, request: Request, context: string): void {
	const ph = posthog();

	if (!ph) return;
	const { distinctId, sessionId } = browserIds(request);
	sendLater(ph.captureExceptionImmediate(cause, distinctId, { context, $session_id: sessionId }));
}
