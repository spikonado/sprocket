import { describe, expect, it } from 'vitest';
import type { Doc, Id } from '@convex/_generated/dataModel';
import {
	computeAccess,
	identityTakeoverAllowed,
	isStalePayload,
	isStaleStatus,
	isStaleSchedule,
	isStaleTerm,
	resolveEffectiveTier,
	type SubscriptionAccessSource,
	type SubscriptionPayload
} from './subscriptionProjection';

const HOUR = 60 * 60 * 1_000;

const T0 = Date.UTC(2026, 5, 15, 12);

function payload(overrides: Partial<SubscriptionPayload> = {}): SubscriptionPayload {
	return {
		dodoSubscriptionId: 'sub_1',
		dodoProductId: 'prod_a',
		dodoCustomerId: 'cus_1',
		status: 'active',
		eventAt: T0,
		billingInterval: 'monthly',
		billingPeriodStart: T0 - 60_000,
		billingPeriodEnd: T0 + 30 * 86_400_000,
		cancelAtNextBillingDate: false,
		scheduledChange: null,
		...overrides
	};
}

function row(overrides: Partial<Doc<'subscriptions'>> = {}): Doc<'subscriptions'> {
	return {
		// SAFETY: pure projection fixtures never perform database id lookup.
		_id: 'subscription_fixture' as Id<'subscriptions'>,
		_creationTime: T0,
		userId: 'u1',
		tier: 'pro',
		status: 'active',
		eventAt: T0,
		payloadEventAt: T0,
		termEventAt: T0,
		dodoSubscriptionId: 'sub_1',
		dodoProductId: 'prod_a',
		billingPeriodStart: T0 - 60_000,
		billingPeriodEnd: T0 + 30 * 86_400_000,
		cancelAtNextBillingDate: false,
		...overrides
	};
}

describe('deterministic payload ordering', () => {
	it('equal-time conflicting products converge irrespective of arrival order', () => {
		const existing = row({ dodoProductId: 'prod_b', tier: 'max' });

		expect(isStalePayload({ existing, payload: payload({ dodoProductId: 'prod_a' }) })).toBe(true);
		expect(isStalePayload({ existing, payload: payload({ dodoProductId: 'prod_c' }) })).toBe(false);
	});

	it('equal-time status uses the terminal-outranks-active rank', () => {
		const existing = row({ status: 'active' });

		expect(isStaleStatus({ existing, payload: payload({ status: 'on_hold' }) })).toBe(false);
		expect(isStaleStatus({ existing, payload: payload({ status: 'failed' }) })).toBe(false);
	});

	it('a historical failure never overrides a newer confirmed term', () => {
		const existing = row({ termEventAt: T0 + 5_000 });

		expect(isStaleTerm(existing, payload({ status: 'failed', eventAt: T0 + 1_000 }))).toBe(true);
		expect(isStaleTerm(existing, payload({ status: 'failed', eventAt: T0 + 9_000 }))).toBe(false);
	});

	it('a newer scheduled change wins the equal-position payload tie on the same product', () => {
		const existing = row({ dodoProductId: 'prod_a', scheduledChange: undefined });

		const scheduled = payload({
			dodoProductId: 'prod_a',
			scheduledChange: { id: 'sc_1', productId: 'prod_b', effectiveAt: T0 + 86_400_000 }
		});

		expect(isStaleSchedule({ existing, payload: scheduled })).toBe(false);

		const stored = row({
			dodoProductId: 'prod_a',
			scheduledChange: { id: 'sc_1', productId: 'prod_b', effectiveAt: T0 + 86_400_000 }
		});

		expect(isStaleSchedule({ existing: stored, payload: payload({ scheduledChange: null }) })).toBe(
			true
		);

		const earlierChange = { id: 'sc_0', productId: 'prod_b', effectiveAt: T0 + 3_600_000 };

		expect(
			isStaleSchedule({ existing: stored, payload: payload({ scheduledChange: earlierChange }) })
		).toBe(true);
		expect(
			isStaleSchedule({ existing: row({ scheduledChange: earlierChange }), payload: scheduled })
		).toBe(false);
	});
});

describe('observation provenance', () => {
	it('an observation orders at retrieval time without changing webhook watermarks', () => {
		const existing = row({
			eventAt: T0 + 1_000,
			payloadEventAt: T0 + 1_000,
			termEventAt: T0 + 1_000
		});

		const observation = payload({
			eventAt: T0 - 86_400_000,
			observedAt: T0 + 2_000,
			billingPeriodStart: T0 - 86_400_000,
			billingPeriodEnd: T0 + 30 * 86_400_000
		});

		expect(isStalePayload({ existing, payload: observation })).toBe(false);

		const delayedWebhook = payload({ eventAt: T0 + 1_500 });
		expect(isStalePayload({ existing, payload: delayedWebhook })).toBe(false);
	});

	it('an observation retrieved before the stored watermark is stale', () => {
		const existing = row({ eventAt: T0 + 5_000, payloadEventAt: T0 + 5_000 });
		const observation = payload({ eventAt: T0, observedAt: T0 + 2_000 });

		expect(isStalePayload({ existing, payload: observation })).toBe(true);
	});
});

describe('access policy', () => {
	const sub: SubscriptionAccessSource = {
		status: 'active',
		dodoSubscriptionId: 'sub_1',
		billingPeriodEnd: T0,
		cancelAtNextBillingDate: false
	};

	it('grants exactly the term plus one hour, anchored to the term end', () => {
		expect(computeAccess(sub, T0 - 1)).toEqual({ accessPhase: 'paid', accessEndsAt: T0 });
		expect(computeAccess(sub, T0 + HOUR / 2)).toEqual({
			accessPhase: 'renewal_processing',
			accessEndsAt: T0 + HOUR
		});
		expect(computeAccess(sub, T0 + HOUR)).toEqual({
			accessPhase: 'none',
			accessEndsAt: T0 + HOUR
		});
	});

	it('scheduled cancellation gets no grace after its deadline', () => {
		const cancelled = { ...sub, cancelAtNextBillingDate: true };

		expect(computeAccess(cancelled, T0 + 1)).toEqual({ accessPhase: 'none', accessEndsAt: T0 });
	});

	it('a Dodo row without a confirmed term fails closed', () => {
		expect(
			computeAccess(
				{ status: 'active', dodoSubscriptionId: 'sub_1', billingPeriodEnd: undefined },
				T0
			)
		).toEqual({ accessPhase: 'none', accessEndsAt: undefined });
	});

	it('operator grants have paid access with no provider clock', () => {
		expect(computeAccess({ status: 'active' }, T0)).toEqual({
			accessPhase: 'paid',
			accessEndsAt: undefined
		});
	});

	it('waits for a positive finite paid term to start', () => {
		expect(
			computeAccess({ ...sub, billingPeriodStart: T0 + 1, billingPeriodEnd: T0 + HOUR }, T0)
		).toEqual({
			accessPhase: 'none',
			accessEndsAt: T0 + 1
		});
		expect(
			computeAccess({ ...sub, billingPeriodStart: T0, billingPeriodEnd: T0 + HOUR }, T0)
		).toEqual({
			accessPhase: 'paid',
			accessEndsAt: T0 + HOUR
		});
		expect(computeAccess({ ...sub, billingPeriodEnd: Infinity }, T0).accessPhase).toBe('none');
	});
});

describe('identity takeover', () => {
	it('requires provider-confirmed termination of the current identity', () => {
		const current = row({ dodoSubscriptionId: 'sub_old', terminalConfirmed: true });
		expect(identityTakeoverAllowed(current, payload({ dodoSubscriptionId: 'sub_new' }))).toBe(
			'apply'
		);

		const ended = row({ dodoSubscriptionId: 'sub_old', accessPhase: 'none', status: 'active' });
		expect(identityTakeoverAllowed(ended, payload({ dodoSubscriptionId: 'sub_new' }))).toBe(
			'competing'
		);

		const held = row({ dodoSubscriptionId: 'sub_old', status: 'on_hold' });
		expect(identityTakeoverAllowed(held, payload({ dodoSubscriptionId: 'sub_new' }))).toBe(
			'competing'
		);

		expect(identityTakeoverAllowed(ended, payload({ dodoSubscriptionId: 'sub_old' }))).toBe(
			'apply'
		);
	});
});

describe('tier resolution', () => {
	const base = { payload: payload(), checkoutTier: null, metadataTier: null, configuredTier: null };

	it('keeps the purchased tier when the product is unchanged even after a remap', () => {
		const existing = row({ tier: 'pro', dodoProductId: 'prod_a' });

		expect(resolveEffectiveTier({ ...base, existing, configuredTier: 'max' })).toEqual({
			tier: 'pro',
			unresolved: false
		});
	});

	it('resolves a changed product through the unique mapping, not old metadata', () => {
		const existing = row({ tier: 'pro', dodoProductId: 'prod_a' });

		expect(
			resolveEffectiveTier({
				...base,
				existing,
				payload: payload({ dodoProductId: 'prod_b' }),
				metadataTier: 'pro',
				configuredTier: 'max'
			})
		).toEqual({ tier: 'max', unresolved: false });
	});

	it('retains an unmappable changed product as unresolved', () => {
		const existing = row({ tier: 'pro', dodoProductId: 'prod_a' });

		expect(
			resolveEffectiveTier({
				...base,
				existing,
				payload: payload({ dodoProductId: 'prod_unknown' })
			})
		).toMatchObject({ unresolved: true });
	});
});
