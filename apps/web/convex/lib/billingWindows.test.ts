import { describe, expect, it } from 'vitest';
import type { Doc } from '@convex/_generated/dataModel';
import { billingWindow } from './billingWindows';

const timestamp = (value: string) => Date.parse(value);

function paidSubscription(interval: 'monthly' | 'annual', start: string, end: string) {
	return {
		status: 'active',
		billingInterval: interval,
		billingPeriodStart: timestamp(start),
		billingPeriodEnd: timestamp(end)
	} as Doc<'subscriptions'>;
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
		expect(billingWindow('monthly', paid, timestamp('2026-02-15T13:40:00Z'))).toEqual({
			start: timestamp('2026-02-01T00:00:00Z'),
			end: timestamp('2026-03-01T00:00:00Z')
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
});
