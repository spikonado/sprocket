import type { Doc } from '@convex/_generated/dataModel';
import { subscriptionAccessPhase } from '@convex/lib/tiers';
import type { UsagePeriod } from '@convex/lib/usageMeters';

const DAY = 86_400_000;

type UsageWindow = { start: number; end: number };

export type BillingWindowSubscription = Pick<
	Doc<'subscriptions'>,
	| 'status'
	| 'dodoSubscriptionId'
	| 'billingInterval'
	| 'billingPeriodStart'
	| 'billingPeriodEnd'
	| 'billingPeriodEnded'
	| 'accessPhase'
	| 'accessEndsAt'
	| 'cancelAtNextBillingDate'
>;

function utcMonth(year: number, month: number, day: number, anchor: Date): number {
	const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

	return Date.UTC(
		year,
		month,
		Math.min(day, lastDay),
		anchor.getUTCHours(),
		anchor.getUTCMinutes(),
		anchor.getUTCSeconds(),
		anchor.getUTCMilliseconds()
	);
}

export function billingWindow(
	period: UsagePeriod,
	subscription: BillingWindowSubscription | null,
	now: number = Date.now()
): UsageWindow {
	const date = new Date(now);

	if (period === 'weekly') {
		const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
		const monday = start - ((date.getUTCDay() + 6) % 7) * DAY;

		return { start: monday, end: monday + 7 * DAY };
	}

	const access = subscriptionAccessPhase(subscription, now);
	const paid = subscription !== null && access !== 'none' && !!subscription.dodoSubscriptionId;

	if (paid && subscription.billingInterval === 'monthly') {
		if (
			subscription.billingPeriodStart === undefined ||
			subscription.billingPeriodEnd === undefined
		) {
			throw new Error('Monthly subscription is missing its Dodo billing dates.');
		}

		// Renewal-processing grace keeps the window frozen at the confirmed
		// term end, so usage keeps charging to the preserved bucket instead of
		// opening a new empty window or dropping to the free monthly window.
		return { start: subscription.billingPeriodStart, end: subscription.billingPeriodEnd };
	}

	if (paid && subscription.billingInterval === 'annual') {
		if (
			subscription.billingPeriodStart === undefined ||
			subscription.billingPeriodEnd === undefined
		) {
			throw new Error('Annual subscription is missing its Dodo billing date.');
		}

		const termEnd = subscription.billingPeriodEnd;

		const anchor = new Date(subscription.billingPeriodStart);
		const firstMonth = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth();
		const effectiveNow = access === 'renewal_processing' ? Math.min(now, termEnd - 1) : now;
		const effectiveDate = new Date(effectiveNow);
		const currentMonth = effectiveDate.getUTCFullYear() * 12 + effectiveDate.getUTCMonth();

		const boundary = (offset: number) =>
			utcMonth(anchor.getUTCFullYear(), anchor.getUTCMonth() + offset, anchor.getUTCDate(), anchor);

		let offset = Math.max(0, currentMonth - firstMonth);

		if (boundary(offset) > effectiveNow && offset > 0) offset--;

		// Walk back while the clamped subwindow is not strictly positive; the
		// term end caps every subwindow at the actual confirmed end.
		for (;;) {
			const start = boundary(offset);
			const end = Math.min(boundary(offset + 1), termEnd);

			if (end > start) return { start, end };

			if (offset <= 0) {
				// The whole confirmed term is shorter than one subwindow; report the
				// positive term itself.
				if (termEnd > subscription.billingPeriodStart) {
					return { start: subscription.billingPeriodStart, end: termEnd };
				}

				throw new Error('Annual subscription term is not positive.');
			}

			offset--;
		}
	}

	const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);

	return { start, end: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) };
}
