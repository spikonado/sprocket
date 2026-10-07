import { describe, expect, it } from 'vitest';
import type { Doc, Id } from '@convex/_generated/dataModel';
import {
	comparePayloads,
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

		// prod_a loses the product tie-break against the stored prod_b.
		expect(isStalePayload({ existing, payload: payload({ dodoProductId: 'prod_a' }) })).toBe(true);
		// prod_c wins the tie-break against the stored prod_b.
		expect(isStalePayload({ existing, payload: payload({ dodoProductId: 'prod_c' }) })).toBe(false);
	});

	it('equal-time status uses the terminal-outranks-active rank', () => {
		const existing = row({ status: 'active' });

		expect(isStaleStatus({ existing, payload: payload({ status: 'on_hold' }) })).toBe(false);
		expect(isStaleStatus({ existing, payload: payload({ status: 'failed' }) })).toBe(false);
	});

	it('scheduled changes participate in the deterministic tie-break', () => {
		const withChange = payload({
			scheduledChange: { id: 'sc_2', productId: 'prod_b', effectiveAt: T0 + 86_400_000 }
		});

		expect(comparePayloads(withChange, payload({ scheduledChange: null }))).toBeGreaterThan(0);

		const earlierEffective = payload({
			scheduledChange: { id: 'sc_1', productId: 'prod_b', effectiveAt: T0 + 3_600_000 }
		});

		expect(comparePayloads(earlierEffective, withChange)).toBeLessThan(0);
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

		// A pending scheduled change is the newer provider state: it is not
		// stale against a stored projection that has none.
		expect(isStaleSchedule({ existing, payload: scheduled })).toBe(false);

		// Clearing the scheduled change at the same position is the older
		// provider state: stale against the stored pending change.
		const stored = row({
			dodoProductId: 'prod_a',
			scheduledChange: { id: 'sc_1', productId: 'prod_b', effectiveAt: T0 + 86_400_000 }
		});

		expect(isStaleSchedule({ existing: stored, payload: payload({ scheduledChange: null }) })).toBe(
			true
		);
	});
});

describe('observation provenance', () => {
	it('an observation orders at retrieval time without changing webhook watermarks', () => {
		// Webhook state advanced to T0+1000 by a provider event; the observation
		// carries an older billing period but was retrieved now.
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

		// The observation is positioned at retrieval time, so it is not stale
		// against the older webhook watermarks...
		expect(isStalePayload({ existing, payload: observation })).toBe(false);

		// ...but a delayed legitimate webhook stamped between the observed
		// period and the retrieval still beats the stored provenance watermark.
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

		// Locally ended access (no terminal confirmation) still blocks.
		const ended = row({ dodoSubscriptionId: 'sub_old', accessPhase: 'none', status: 'active' });
		expect(identityTakeoverAllowed(ended, payload({ dodoSubscriptionId: 'sub_new' }))).toBe(
			'competing'
		);

		// Recoverable payment hold blocks too.
		const held = row({ dodoSubscriptionId: 'sub_old', status: 'on_hold' });
		expect(identityTakeoverAllowed(held, payload({ dodoSubscriptionId: 'sub_new' }))).toBe(
			'competing'
		);

		// Same identity always applies.
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
