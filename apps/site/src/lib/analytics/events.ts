import type { BillingInterval } from '@/lib/pricing/convex-types';
import type { SprocketDesktopPlatform, SprocketOsFamily } from '@/lib/sprocket-releases';

type Checkout = { plan: string; interval: BillingInterval } | { pack: string };

/** Autocapture covers plain clicks. */
export type AnalyticsEvents = {
	section_viewed: { section: string };
	sprocket_download_clicked: {
		variant: 'primary' | 'alternate';
		os: SprocketOsFamily | 'unknown';
		/** Absent when the link opens the releases page instead of a download. */
		platform?: SprocketDesktopPlatform;
		release_tag: string;
	};
	install_command_copied: { command: string };
	pricing_interval_selected: { interval: BillingInterval };
	pricing_plan_selected: { plan: string; interval: BillingInterval; signed_in: boolean };
	pricing_credit_pack_selected: { pack: string; signed_in: boolean };
	pricing_checkout_started: Checkout;
	pricing_checkout_redirected: Checkout;
	pricing_checkout_failed: Checkout;
	pricing_checkout_cancelled: Record<string, never>;
	pricing_subscription_activated: { plan: string };
	pricing_credits_added: { pack: string };
	pricing_activation_timed_out: Checkout;
	pricing_sign_in_failed: Record<string, never>;
};
