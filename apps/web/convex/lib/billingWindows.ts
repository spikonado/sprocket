import type { Doc } from '@convex/_generated/dataModel';
import type { UsagePeriod } from '@convex/lib/usageMeters';

const DAY = 86_400_000;

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
	subscription: Doc<'subscriptions'> | null,
	now: number
): { start: number; end: number } {
	const date = new Date(now);
	if (period === 'weekly') {
		const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
		const monday = start - ((date.getUTCDay() + 6) % 7) * DAY;
		return { start: monday, end: monday + 7 * DAY };
	}

	const paid =
		subscription?.status === 'active' &&
		(subscription.billingPeriodEnd === undefined || now < subscription.billingPeriodEnd);
	if (paid && subscription.billingInterval === 'monthly') {
		if (
			subscription.billingPeriodStart === undefined ||
			subscription.billingPeriodEnd === undefined
		) {
			throw new Error('Monthly subscription is missing its Dodo billing dates.');
		}
		return { start: subscription.billingPeriodStart, end: subscription.billingPeriodEnd };
	}

	if (paid && subscription.billingInterval === 'annual') {
		if (subscription.billingPeriodStart === undefined) {
			throw new Error('Annual subscription is missing its Dodo billing date.');
		}
		const anchor = new Date(subscription.billingPeriodStart);
		const firstMonth = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth();
		const currentMonth = date.getUTCFullYear() * 12 + date.getUTCMonth();
		const boundary = (offset: number) =>
			utcMonth(anchor.getUTCFullYear(), anchor.getUTCMonth() + offset, anchor.getUTCDate(), anchor);
		let offset = Math.max(0, currentMonth - firstMonth);
		if (boundary(offset) > now && offset > 0) offset--;
		return { start: boundary(offset), end: boundary(offset + 1) };
	}

	const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
	return { start, end: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) };
}
