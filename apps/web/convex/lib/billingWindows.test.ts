import { describe, expect, it } from 'vitest';
import { billingWindow } from './billingWindows';

const timestamp = (value: string) => Date.parse(value);

function paidSubscription(interval: 'monthly' | 'annual', start: string, end: string) {
	return { interval, billingPeriodStart: timestamp(start), billingPeriodEnd: timestamp(end) };
}

describe('UTC usage windows', () => {
	it('uses calendar months for free and Dodo billing dates for monthly plans', () => {
		expect(billingWindow(null, timestamp('2028-02-29T23:59:59Z'))).toEqual({
			start: timestamp('2028-02-01T00:00:00Z'),
			end: timestamp('2028-03-01T00:00:00Z')
		});
		const paid = paidSubscription('monthly', '2026-01-15T13:40:00Z', '2026-02-15T13:40:00Z');
		expect(billingWindow(paid, timestamp('2026-02-01T00:00:00Z'))).toEqual({
			start: timestamp('2026-01-15T13:40:00Z'),
			end: timestamp('2026-02-15T13:40:00Z')
		});
		expect(billingWindow(paid, timestamp('2026-02-15T13:40:00Z'))).toEqual({
			start: timestamp('2026-01-15T13:40:00Z'),
			end: timestamp('2026-02-15T13:40:00Z')
		});
	});

	it('clamps annual anchors to short months, then restores the original day and time', () => {
		const paid = paidSubscription('annual', '2026-01-31T18:45:11Z', '2027-01-31T18:45:11Z');
		expect(billingWindow(paid, timestamp('2026-02-28T18:45:10Z'))).toEqual({
			start: timestamp('2026-01-31T18:45:11Z'),
			end: timestamp('2026-02-28T18:45:11Z')
		});
		expect(billingWindow(paid, timestamp('2026-02-28T18:45:11Z'))).toEqual({
			start: timestamp('2026-02-28T18:45:11Z'),
			end: timestamp('2026-03-31T18:45:11Z')
		});
		expect(billingWindow(paid, timestamp('2026-04-30T18:45:11Z'))).toEqual({
			start: timestamp('2026-04-30T18:45:11Z'),
			end: timestamp('2026-05-31T18:45:11Z')
		});
	});

	it('clamps annual subwindows to the confirmed term end and stays positive', () => {
		const paid = paidSubscription('annual', '2026-01-15T00:00:00Z', '2027-01-15T00:00:00Z');

		const last = billingWindow(paid, timestamp('2027-01-01T00:00:00Z'));
		expect(last.start).toBe(timestamp('2026-12-15T00:00:00Z'));
		expect(last.end).toBe(timestamp('2027-01-15T00:00:00Z'));
		expect(last.end).toBeGreaterThan(last.start);

		const short = paidSubscription('annual', '2026-01-15T00:00:00Z', '2026-01-20T00:00:00Z');
		const shortWindow = billingWindow(short, timestamp('2026-01-18T00:00:00Z'));
		expect(shortWindow).toEqual({
			start: timestamp('2026-01-15T00:00:00Z'),
			end: timestamp('2026-01-20T00:00:00Z')
		});
		expect(shortWindow.end).toBeGreaterThan(shortWindow.start);
	});

	it('keeps the last paid window open during renewal grace', () => {
		const paid = paidSubscription('monthly', '2026-01-15T00:00:00Z', '2026-02-15T00:00:00Z');

		expect(billingWindow(paid, timestamp('2026-02-15T00:30:00Z'))).toEqual({
			start: timestamp('2026-01-15T00:00:00Z'),
			end: timestamp('2026-02-15T00:00:00Z')
		});

		const annual = paidSubscription('annual', '2026-01-15T00:00:00Z', '2027-01-15T00:00:00Z');
		expect(billingWindow(annual, timestamp('2027-01-15T00:30:00Z'))).toEqual({
			start: timestamp('2026-12-15T00:00:00Z'),
			end: timestamp('2027-01-15T00:00:00Z')
		});
	});
});
