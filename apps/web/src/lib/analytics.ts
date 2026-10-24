import posthog from 'posthog-js';
// Bundled because ad blockers (EasyPrivacy) block the lazily loaded `/posthog-recorder.js` on any host.
import 'posthog-js/dist/posthog-recorder';
import { authState } from '$lib/auth';
import type { RuntimeConfig } from '$lib/runtime-config';

const SHARE_CONTENT_STORAGE_KEY = 'sprocket.analytics.shareConversationContent';

let initialized = false;

let masked = false;

function maskingConfig(mask: boolean) {
	return {
		mask_all_text: mask,
		mask_all_element_attributes: mask,
		session_recording: mask
			? { maskAllInputs: true, maskTextSelector: '*' }
			: { maskAllInputs: false }
	};
}

export function initAnalytics(config: RuntimeConfig): void {
	const key = config.env.PUBLIC_POSTHOG_KEY?.trim();

	if (!key || initialized) return;
	initialized = true;
	masked = localStorage.getItem(SHARE_CONTENT_STORAGE_KEY) === 'false';

	posthog.init(key, {
		api_host: config.env.PUBLIC_POSTHOG_HOST || 'https://eu.i.posthog.com',
		ui_host: 'https://eu.posthog.com',
		defaults: '2026-08-30',
		capture_exceptions: true,
		...maskingConfig(masked)
	});
	posthog.register({
		site: 'sprocket_app',
		client: window.sprocketDesktopBridge ? 'desktop' : 'web',
		app_version: config.version ?? null
	});

	syncAnalyticsUser();
	authState.subscribe(syncAnalyticsUser);
}

function syncAnalyticsUser(): void {
	const { user, isReady, isLoading } = authState.getSnapshot();

	if (user) {
		if (posthog.get_distinct_id() !== user.id) posthog.identify(user.id, { email: user.email });
	} else if (isReady && !isLoading && posthog.get_property('$user_state') === 'identified') {
		posthog.reset();
	}
}

export function syncShareConversationContent(share: boolean): void {
	if (!initialized) return;
	localStorage.setItem(SHARE_CONTENT_STORAGE_KEY, String(share));

	if (masked === !share) return;
	masked = !share;
	posthog.set_config(maskingConfig(masked));

	// The recorder reads masking when it starts, so restart it to apply the change.
	if (posthog.sessionRecordingStarted()) {
		posthog.stopSessionRecording();
		posthog.startSessionRecording();
	}
}

export function captureRenderError(error: Error, componentStack: string | null | undefined): void {
	if (initialized) posthog.captureException(error, { component_stack: componentStack });
}
