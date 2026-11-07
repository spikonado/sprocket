import type { PaidTerm } from '@convex/lib/tiers';

type UsageWindow = { start: number; end: number };

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

/** Free and granted tiers use calendar months; paid terms use their Dodo billing period. */
export function billingWindow(term: PaidTerm | null, now: number): UsageWindow {
	const date = new Date(now);

	if (term?.interval === 'monthly') {
		return { start: term.billingPeriodStart, end: term.billingPeriodEnd };
	}

	if (term?.interval === 'annual') {
		const termEnd = term.billingPeriodEnd;
		const anchor = new Date(term.billingPeriodStart);
		const firstMonth = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth();
		// During renewal grace the last subwindow stays open.
		const effectiveNow = Math.min(now, termEnd - 1);
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
				if (termEnd > term.billingPeriodStart) {
					return { start: term.billingPeriodStart, end: termEnd };
				}

				throw new Error('Annual subscription term is not positive.');
			}

			offset--;
		}
	}

	const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);

	return { start, end: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) };
}
