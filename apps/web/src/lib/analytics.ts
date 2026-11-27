import { dropExceptionsOutsideApp } from '@sprocket/error-tracking';
import posthog from 'posthog-js';
// Bundled because ad blockers (EasyPrivacy) block the lazily loaded `/posthog-recorder.js` on any host.
import 'posthog-js/dist/posthog-recorder';
import { authState } from '$lib/auth';
import type { RuntimeConfig } from '$lib/runtime-config';

let initialized = false;

export function initAnalytics(config: RuntimeConfig): void {
	const key = config.env.PUBLIC_POSTHOG_KEY?.trim();

	if (!key || initialized) return;
	initialized = true;

	posthog.init(key, {
		api_host: config.env.PUBLIC_POSTHOG_HOST || 'https://eu.i.posthog.com',
		ui_host: 'https://eu.posthog.com',
		defaults: '2026-08-30',
		capture_exceptions: true,
		before_send: dropExceptionsOutsideApp,
		mask_all_text: true,
		mask_all_element_attributes: true,
		session_recording: { maskAllInputs: true, maskTextSelector: '*' }
	});
	registerSuperProperties(config);

	syncAnalyticsUser(config);
	authState.subscribe(() => syncAnalyticsUser(config));
}

function registerSuperProperties(config: RuntimeConfig): void {
	posthog.register({
		site: 'sprocket_app',
		client: window.sprocketDesktopBridge ? 'desktop' : 'web',
		app_version: config.version ?? null
	});
}

function syncAnalyticsUser(config: RuntimeConfig): void {
	const { user, isReady, isLoading } = authState.getSnapshot();

	if (user) {
		if (posthog.get_distinct_id() !== user.id) posthog.identify(user.id, { email: user.email });
	} else if (isReady && !isLoading && posthog.get_property('$user_state') === 'identified') {
		posthog.reset();
		registerSuperProperties(config);
	}
}

export function captureRenderError(error: Error, componentStack: string | null | undefined): void {
	if (initialized) posthog.captureException(error, { component_stack: componentStack });
}

export function analyticsSessionId(): string | undefined {
	return initialized ? posthog.get_session_id() : undefined;
}
