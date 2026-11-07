import type { BillingInterval } from '@/lib/convex/api';

type Checkout = { plan: string; interval: BillingInterval };

/** Every custom PostHog event and its properties. Autocapture covers plain clicks. */
export type AnalyticsEvents = {
	section_viewed: { section: string };
	sprocket_download_clicked: {
		variant: 'primary' | 'alternate' | 'all_releases';
		platform: string;
		filename?: string;
		release_tag?: string;
	};
	install_command_copied: { command: string };
	product_media_opened: { media: 'sprocket_screenshot' };
	newsletter_subscribe_submitted: Record<string, never>;
	newsletter_subscribed: Record<string, never>;
	newsletter_subscribe_failed: { reason: string; source: 'client' | 'server' };
	pricing_interval_selected: { interval: BillingInterval };
	pricing_plan_selected: Checkout & { signed_in: boolean };
	pricing_checkout_started: Checkout;
	pricing_checkout_redirected: Checkout;
	pricing_checkout_failed: Checkout;
	pricing_checkout_cancelled: Record<string, never>;
	pricing_subscription_activated: { plan: string };
	pricing_activation_timed_out: { plan: string };
	pricing_sign_in_failed: Record<string, never>;
};

export type AnalyticsEvent = keyof AnalyticsEvents;
