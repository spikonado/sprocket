import posthog from 'posthog-js';
import { authState } from '$lib/auth';
import type { RuntimeConfig } from '$lib/runtime-config';

const SHARE_CONTENT_STORAGE_KEY = 'sprocket.analytics.shareConversationContent';

let initialized = false;

let replayMasked = false;

let recording = false;

export function initAnalytics(config: RuntimeConfig): void {
	const key = config.env.PUBLIC_POSTHOG_KEY?.trim();

	if (!key || initialized) return;
	initialized = true;

	// The replay recorder reads masking once at start, so the last synced preference sets it for this load.
	replayMasked = localStorage.getItem(SHARE_CONTENT_STORAGE_KEY) === 'false';

	const session_recording = replayMasked
		? { maskAllInputs: true, maskTextSelector: '*' }
		: { maskAllInputs: false };

	posthog.init(key, {
		api_host: config.env.PUBLIC_POSTHOG_HOST || 'https://eu.i.posthog.com',
		ui_host: 'https://eu.posthog.com',
		defaults: '2026-08-30',
		capture_exceptions: true,
		session_recording,
		// A fresh browser can't know the account's preference, so replay waits for it.
		disable_session_recording: true
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

	const allowed = share || replayMasked;

	if (allowed === recording) return;
	recording = allowed;

	if (allowed) posthog.startSessionRecording();
	else posthog.stopSessionRecording();
}

export function captureRenderError(error: Error, componentStack: string | null | undefined): void {
	if (initialized) posthog.captureException(error, { component_stack: componentStack });
}
