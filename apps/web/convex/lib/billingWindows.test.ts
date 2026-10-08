import { describe, expect, it } from 'vitest';
import { billingWindow, type BillingWindowSubscription } from './billingWindows';

const timestamp = (value: string) => Date.parse(value);

function paidSubscription(
	interval: 'monthly' | 'annual',
	start: string,
	end: string,
	overrides: Partial<BillingWindowSubscription> = {}
) {
	return {
		status: 'active' as const,
		dodoSubscriptionId: 'sub_test',
		billingInterval: interval,
		billingPeriodStart: timestamp(start),
		billingPeriodEnd: timestamp(end),
		...overrides
	};
}

describe('UTC usage windows', () => {
	it('starts weekly usage on Monday regardless of first use or tier', () => {
		expect(billingWindow('weekly', null, timestamp('2026-02-01T23:59:59Z'))).toEqual({
			start: timestamp('2026-01-26T00:00:00Z'),
			end: timestamp('2026-02-02T00:00:00Z')
		});
		expect(billingWindow('weekly', null, timestamp('2026-02-02T00:00:00Z'))).toEqual({
			start: timestamp('2026-02-02T00:00:00Z'),
			end: timestamp('2026-02-09T00:00:00Z')
		});
	});

	it('uses calendar months for free and Dodo billing dates for monthly plans', () => {
		expect(billingWindow('monthly', null, timestamp('2028-02-29T23:59:59Z'))).toEqual({
			start: timestamp('2028-02-01T00:00:00Z'),
			end: timestamp('2028-03-01T00:00:00Z')
		});
		const paid = paidSubscription('monthly', '2026-01-15T13:40:00Z', '2026-02-15T13:40:00Z');
		expect(billingWindow('monthly', paid, timestamp('2026-02-01T00:00:00Z'))).toEqual({
			start: timestamp('2026-01-15T13:40:00Z'),
			end: timestamp('2026-02-15T13:40:00Z')
		});
		// Exactly at the term end the one-hour renewal-processing grace freezes
		// the last paid window; the free monthly calendar does not take over.
		expect(billingWindow('monthly', paid, timestamp('2026-02-15T13:40:00Z'))).toEqual({
			start: timestamp('2026-01-15T13:40:00Z'),
			end: timestamp('2026-02-15T13:40:00Z')
		});
	});

	it('clamps annual anchors to short months, then restores the original day and time', () => {
		const paid = paidSubscription('annual', '2026-01-31T18:45:11Z', '2027-01-31T18:45:11Z');
		expect(billingWindow('monthly', paid, timestamp('2026-02-28T18:45:10Z'))).toEqual({
			start: timestamp('2026-01-31T18:45:11Z'),
			end: timestamp('2026-02-28T18:45:11Z')
		});
		expect(billingWindow('monthly', paid, timestamp('2026-02-28T18:45:11Z'))).toEqual({
			start: timestamp('2026-02-28T18:45:11Z'),
			end: timestamp('2026-03-31T18:45:11Z')
		});
		expect(billingWindow('monthly', paid, timestamp('2026-04-30T18:45:11Z'))).toEqual({
			start: timestamp('2026-04-30T18:45:11Z'),
			end: timestamp('2026-05-31T18:45:11Z')
		});
	});

	it('keeps operator grants on calendar windows even with billing dates present', () => {
		const grant = paidSubscription('annual', '2026-01-31T18:45:11Z', '2027-01-31T18:45:11Z', {
			dodoSubscriptionId: undefined,
			billingPeriodEnded: true
		});

		expect(billingWindow('monthly', grant, timestamp('2026-02-28T18:45:10Z'))).toEqual({
			start: timestamp('2026-02-01T00:00:00Z'),
			end: timestamp('2026-03-01T00:00:00Z')
		});
	});

	it('clamps annual subwindows to the confirmed term end and stays positive', () => {
		const paid = paidSubscription('annual', '2026-01-15T00:00:00Z', '2027-01-15T00:00:00Z');

		// The final subwindow is capped at the actual confirmed term end.
		const last = billingWindow('monthly', paid, timestamp('2027-01-01T00:00:00Z'));
		expect(last.start).toBe(timestamp('2026-12-15T00:00:00Z'));
		expect(last.end).toBe(timestamp('2027-01-15T00:00:00Z'));
		expect(last.end).toBeGreaterThan(last.start);

		// A short confirmed term shorter than one subwindow reports the term itself.
		const short = paidSubscription('annual', '2026-01-15T00:00:00Z', '2026-01-20T00:00:00Z');
		const shortWindow = billingWindow('monthly', short, timestamp('2026-01-18T00:00:00Z'));
		expect(shortWindow).toEqual({
			start: timestamp('2026-01-15T00:00:00Z'),
			end: timestamp('2026-01-20T00:00:00Z')
		});
		expect(shortWindow.end).toBeGreaterThan(shortWindow.start);
	});

	it('freezes the paid monthly window during renewal-processing grace', () => {
		const paid = paidSubscription('monthly', '2026-01-15T00:00:00Z', '2026-02-15T00:00:00Z', {
			accessPhase: 'renewal_processing',
			accessEndsAt: timestamp('2026-02-15T01:00:00Z')
		});

		// During grace, the window stays on the preserved paid bucket instead of
		// opening a new empty window or switching to the free calendar month.
		expect(billingWindow('monthly', paid, timestamp('2026-02-15T00:30:00Z'))).toEqual({
			start: timestamp('2026-01-15T00:00:00Z'),
			end: timestamp('2026-02-15T00:00:00Z')
		});
	});
});
