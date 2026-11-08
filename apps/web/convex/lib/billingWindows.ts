import type { PaidTerm } from '@convex/lib/tiers';

type UsageWindow = { start: number; end: number };

export function utcMonth(year: number, month: number, day: number, anchor: Date): number {
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

export function billingWindow(term: PaidTerm | null, now: number): UsageWindow {
	const date = new Date(now);

	if (term?.interval === 'monthly') {
		return { start: term.billingPeriodStart, end: term.billingPeriodEnd };
	}

	if (term?.interval === 'annual') {
		const termEnd = term.billingPeriodEnd;
		const anchor = new Date(term.billingPeriodStart);
		const firstMonth = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth();
		const nowInTerm = Math.min(now, termEnd - 1);
		const dateInTerm = new Date(nowInTerm);
		const currentMonth = dateInTerm.getUTCFullYear() * 12 + dateInTerm.getUTCMonth();

		const boundary = (offset: number) =>
			utcMonth(anchor.getUTCFullYear(), anchor.getUTCMonth() + offset, anchor.getUTCDate(), anchor);

		let offset = Math.max(0, currentMonth - firstMonth);

		if (boundary(offset) > nowInTerm && offset > 0) offset--;

		const start = boundary(offset);
		const end = Math.min(boundary(offset + 1), termEnd);

		if (end <= start) throw new Error('Annual subscription term is not positive.');

		return { start, end };
	}

	const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);

	return { start, end: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) };
}
