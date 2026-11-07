import { waitUntil } from '@vercel/functions';
import { PostHog } from 'posthog-node';
import type { AnalyticsEvent, AnalyticsEvents } from '@/lib/analytics/events';

const POSTHOG_KEY = import.meta.env.PUBLIC_POSTHOG_KEY?.trim();

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

// Sends after the response, so analytics never delays or fails a request.
function sendLater(send: Promise<void>): void {
	waitUntil(send.catch(() => {}));
}

export function trackServerEvent<E extends AnalyticsEvent>(
	request: Request,
	event: E,
	properties: AnalyticsEvents[E],
	personProperties?: Record<string, unknown>
): void {
	const ph = posthog();
	if (!ph) return;
	const { distinctId, sessionId } = browserIds(request);
	sendLater(
		ph.captureImmediate({
			// Without a browser ID, count the event without creating a person.
			distinctId: distinctId ?? crypto.randomUUID(),
			event,
			properties: {
				...properties,
				$session_id: sessionId,
				...(distinctId ? { $set: personProperties } : { $process_person_profile: false })
			}
		})
	);
}

export function captureServerException(
	error: unknown,
	request: Request,
	properties: Record<string, unknown>
): void {
	const ph = posthog();
	if (!ph) return;
	const { distinctId, sessionId } = browserIds(request);
	sendLater(
		ph.captureExceptionImmediate(error, distinctId, { ...properties, $session_id: sessionId })
	);
}
