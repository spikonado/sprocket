import { describe, expect, it } from 'vitest';
import type { Doc } from '@convex/_generated/dataModel';
import { computeAccess } from './subscriptionProjection';
import {
	RENEWAL_GRACE_MS,
	displayAccessPhase,
	displayTier,
	enforcementAccessPhase,
	enforcementTier
} from './tiers';

const T0 = Date.UTC(2026, 5, 15, 12);

const termStart = T0 - 60_000;

const termEnd = T0 + 60_000;

type AccessRow = Pick<
	Doc<'subscriptions'>,
	| 'tier'
	| 'status'
	| 'dodoSubscriptionId'
	| 'billingPeriodStart'
	| 'billingPeriodEnd'
	| 'cancelAtNextBillingDate'
	| 'accessPhase'
	| 'accessEndsAt'
>;

function row(overrides: Partial<AccessRow> = {}): AccessRow {
	return {
		tier: 'pro',
		status: 'active',
		dodoSubscriptionId: 'sub_1',
		billingPeriodStart: termStart,
		billingPeriodEnd: termEnd,
		accessPhase: 'paid',
		accessEndsAt: termEnd,
		...overrides
	};
}

describe('paid access', () => {
	it('keeps operator grants paid while active, whatever phase is stored', () => {
		const grant = row({ dodoSubscriptionId: undefined, accessPhase: 'none' });

		expect(enforcementTier(grant, termEnd + RENEWAL_GRACE_MS)).toBe('pro');
		expect(displayTier(grant)).toBe('pro');
		expect(displayAccessPhase({ ...grant, status: 'cancelled' })).toBe('none');
	});

	it('enforcement re-checks the clock while display waits for the scheduler', () => {
		const stale = row({ accessPhase: 'renewal_processing' });

		expect(enforcementTier(stale, termEnd + RENEWAL_GRACE_MS)).toBe('free');
		expect(displayTier(stale)).toBe('pro');
	});

	it('a stored none ends access unless it only waits for the term to start', () => {
		expect(enforcementAccessPhase(row({ accessPhase: 'none' }), T0)).toBe('none');
		expect(enforcementAccessPhase(row({ accessPhase: 'none', accessEndsAt: termStart }), T0)).toBe(
			'paid'
		);
	});

	it('enforcement and display agree with the materialized access at every boundary', () => {
		const subscription = row();

		for (const now of [termStart - 1, T0, termEnd, termEnd + RENEWAL_GRACE_MS]) {
			const materialized = { ...subscription, ...computeAccess(subscription, now) };

			expect(enforcementAccessPhase(materialized, now)).toBe(materialized.accessPhase);
			expect(displayAccessPhase(materialized)).toBe(materialized.accessPhase);
		}
	});
});
