import posthog from 'posthog-js';
import type { AnalyticsEvent, AnalyticsEvents } from '@/lib/analytics/events';

const POSTHOG_KEY = import.meta.env.PUBLIC_POSTHOG_KEY?.trim();

/**
 * PostHog autocapture adds `data-ph-capture-attribute-*` values from a clicked element and its
 * ancestors to the click event. Sections inside `<main>` also emit `section_viewed`.
 */
const SECTION_ATTRIBUTE = 'data-ph-capture-attribute-section';

let initialized = false;

// Islands can capture before the layout script runs, so every call initializes on demand.
function client(): typeof posthog | undefined {
	if (!initialized) {
		initialized = true;
		if (!POSTHOG_KEY) {
			if (import.meta.env.DEV) {
				console.error(
					'PUBLIC_POSTHOG_KEY variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once PUBLIC_POSTHOG_KEY is configured'
				);
			}
			return undefined;
		}
		posthog.init(POSTHOG_KEY, {
			api_host: 'https://kpg.spikonado.com',
			ui_host: 'https://eu.posthog.com',
			defaults: '2026-08-30',
			strict_script_versioning: true,
			capture_exceptions: true,
			capture_performance: { web_vitals: true, network_timing: true },
			// Links API route events and errors to the browser's person and session replay.
			tracing_headers: [window.location.hostname]
		});
		posthog.register({ site: 'spikonado_marketing' });
		trackSectionViews();
	}
	return POSTHOG_KEY ? posthog : undefined;
}

export function initAnalytics(): void {
	client();
}

/** Pass `source` to record which page section the event came from. */
export function track<E extends AnalyticsEvent>(
	event: E,
	properties: AnalyticsEvents[E],
	source?: Element
): void {
	const section = source?.closest(`[${SECTION_ATTRIBUTE}]`)?.getAttribute(SECTION_ATTRIBUTE);
	client()?.capture(event, section ? { ...properties, section } : properties);
}

export function captureException(error: unknown, properties: Record<string, unknown>): void {
	client()?.captureException(error, properties);
}

/**
 * The WorkOS user ID is the Sprocket account ID, so it stays stable across devices.
 * `null` only resets identified visitors, so anonymous visitors keep their history.
 */
export function setAnalyticsUser(user: { id: string; email: string } | null): void {
	const ph = client();
	if (!ph) return;
	if (user) ph.identify(user.id, { email: user.email });
	else if (ph.get_property('$user_state') === 'identified') ph.reset();
}

function trackSectionViews(): void {
	if (typeof IntersectionObserver === 'undefined') return;
	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				const section = entry.target.getAttribute(SECTION_ATTRIBUTE);
				if (!entry.isIntersecting || !section) continue;
				observer.unobserve(entry.target);
				posthog.capture('section_viewed', { section } satisfies AnalyticsEvents['section_viewed']);
			}
		},
		{ threshold: 0.35, rootMargin: '0px 0px -10% 0px' }
	);
	document.querySelectorAll(`main [${SECTION_ATTRIBUTE}]`).forEach((el) => observer.observe(el));
}
