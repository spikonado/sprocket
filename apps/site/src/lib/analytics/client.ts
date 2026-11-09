import { PUBLIC_POSTHOG_KEY } from 'astro:env/client';
import posthog from 'posthog-js';
import type { AnalyticsEvents } from '@/lib/analytics/events';

const POSTHOG_KEY = PUBLIC_POSTHOG_KEY?.trim();

/**
 * PostHog autocapture adds `data-ph-capture-attribute-*` values from a clicked element and its
 * ancestors to the click event. Sections inside `<main>` also emit `section_viewed`.
 */
const SECTION_ATTRIBUTE = 'data-ph-capture-attribute-section';

let initialized = false;

let sectionObserver: IntersectionObserver | undefined;

const reportedSections = new Set<string>();

function ensurePosthog(): typeof posthog | undefined {
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
			disable_capture_url_hashes: false,
			strict_script_versioning: true,
			capture_exceptions: true,
			capture_performance: { web_vitals: true, network_timing: true },
			// Links API route events and errors to the browser's person and session replay.
			tracing_headers: [window.location.hostname]
		});
		posthog.register({ site: 'usesprocket' });
		trackSectionViews();
	}

	return POSTHOG_KEY ? posthog : undefined;
}

export function initAnalytics(): void {
	ensurePosthog();
}

export function track<E extends keyof AnalyticsEvents>(
	event: E,
	properties: AnalyticsEvents[E],
	source?: Element
): void {
	const section = source?.closest(`[${SECTION_ATTRIBUTE}]`)?.getAttribute(SECTION_ATTRIBUTE);
	ensurePosthog()?.capture(event, section ? { ...properties, section } : properties);
}

export function captureException(cause: unknown, context: string): void {
	ensurePosthog()?.captureException(cause, { context });
}

export function observeSection(section: Element): () => void {
	ensurePosthog();
	sectionObserver?.observe(section);

	return () => sectionObserver?.unobserve(section);
}

export function setAnalyticsUser(user: { id: string; email: string } | null): void {
	const ph = ensurePosthog();

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

				if (reportedSections.has(section)) continue;
				reportedSections.add(section);
				posthog.capture('section_viewed', { section } satisfies AnalyticsEvents['section_viewed']);
			}
		},
		{ threshold: 0.35, rootMargin: '0px 0px -10% 0px' }
	);

	sectionObserver = observer;
	document.querySelectorAll(`main [${SECTION_ATTRIBUTE}]`).forEach((el) => observer.observe(el));
}
