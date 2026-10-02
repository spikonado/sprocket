import type { Doc } from '@convex/_generated/dataModel';
import { RENEWAL_GRACE_MS } from '@convex/lib/tiers';

type AccessPhase = 'paid' | 'renewal_processing' | 'none';

export type SubscriptionPayload = {
	dodoSubscriptionId: string;
	dodoProductId: string;
	dodoCustomerId: string;
	status:
		'active' | 'on_hold' | 'cancelled' | 'expired' | 'failed' | 'paused' | 'pending' | 'past_due';
	eventAt: number;
	// When this observation was retrieved from the provider. Absent on
	// webhook events; present on reconciliation observations, which carry
	// `eventAt` only as billing-period provenance and order behind any
	// webhook event stamped at or after `observedAt`.
	observedAt?: number;
	billingInterval: 'monthly' | 'annual';
	billingPeriodStart: number;
	billingPeriodEnd: number;
	cancelAtNextBillingDate: boolean;
	scheduledChange: { id: string; productId: string; effectiveAt: number } | null;
};

export function statusRank(status: string): number {
	switch (status) {
		case 'failed':
			return 6;
		case 'expired':
			return 5;
		case 'cancelled':
			return 4;
		case 'on_hold':
		case 'past_due':
			return 3;
		case 'active':
			return 2;
		default:
			// Provider statuses without a stored convergence rank (pending,
			// paused) never outrank a recognized one.
			return 0;
	}
}

export function normalizedTerminalOrHold(status: string): boolean {
	return (
		status === 'on_hold' ||
		status === 'past_due' ||
		status === 'expired' ||
		status === 'failed' ||
		status === 'cancelled'
	);
}

/**
 * Total order over same-subscription payloads: event time first, then status
 * rank, then product id, then scheduled-change target. Equal-time deliveries
 * converge deterministically regardless of arrival order.
 */
export function comparePayloads(
	a: {
		eventAt: number;
		status: string;
		dodoProductId: string;
		scheduledChange?: ScheduledChange | null;
	},
	b: {
		eventAt: number;
		status: string;
		dodoProductId: string;
		scheduledChange?: ScheduledChange | null;
	}
): number {
	if (a.eventAt !== b.eventAt) return a.eventAt - b.eventAt;

	const rank = statusRank(a.status) - statusRank(b.status);

	if (rank !== 0) return rank;

	if (a.dodoProductId !== b.dodoProductId) return a.dodoProductId < b.dodoProductId ? -1 : 1;

	return compareScheduledChanges(a.scheduledChange ?? null, b.scheduledChange ?? null);
}

// Ordering position against a stored watermark. Observations order at their
// retrieval time (`observedAt`) instead of their provenance `eventAt`;
// `observedAt` is never written into a watermark, so it cannot fence out a
// delayed legitimate webhook.
function orderAt(payload: { eventAt: number; observedAt?: number }): number {
	return payload.observedAt ?? payload.eventAt;
}

type ScheduledChange = { id: string; productId: string; effectiveAt: number };

// A pending scheduled change outranks none (it is the newer provider state);
// two pending changes order by effective time, then target product, then id.
function compareScheduledChanges(a: ScheduledChange | null, b: ScheduledChange | null): number {
	if (!a && !b) return 0;

	if (!a) return -1;

	if (!b) return 1;

	if (a.effectiveAt !== b.effectiveAt) return a.effectiveAt - b.effectiveAt;

	if (a.productId !== b.productId) return a.productId < b.productId ? -1 : 1;

	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Tier resolution priority: checkout reservation, then current tier when the
// product is unchanged, then the configured mapping for the payload product.
// A changed product never trusts the old signed metadata tier id.
export function resolveEffectiveTier(args: {
	existing: Doc<'subscriptions'> | null;
	payload: SubscriptionPayload;
	checkoutTier: string | null;
	metadataTier: string | null;
	configuredTier: string | null;
}): { tier: string; unresolved: false } | { unresolved: true; detail: string } {
	const { existing, payload, checkoutTier, metadataTier } = args;

	if (checkoutTier && metadataTier && checkoutTier !== metadataTier) {
		throw new Error('Dodo subscription tier metadata does not match its checkout reservation.');
	}

	const unchangedProduct =
		existing?.dodoSubscriptionId === payload.dodoSubscriptionId &&
		existing.dodoProductId === payload.dodoProductId;

	// Preserve the purchased tier across operator product remaps.
	if (unchangedProduct) return { tier: existing.tier, unresolved: false };

	if (checkoutTier) return { tier: checkoutTier, unresolved: false };

	if (args.configuredTier) return { tier: args.configuredTier, unresolved: false };

	return {
		unresolved: true,
		detail: `No tier mapping for Dodo product ${payload.dodoProductId}.`
	};
}

type TransitionFences = {
	existing: Doc<'subscriptions'> | null;
	payload: SubscriptionPayload;
};

// Product fence on the payloadEventAt watermark; independent from the status
// fence, so a winning status never blocks a winning product and vice versa.
export function isStalePayload({ existing, payload }: TransitionFences): boolean {
	if (!existing) return false;

	if (existing.dodoSubscriptionId !== payload.dodoSubscriptionId) return false;

	const watermark = existing.payloadEventAt ?? existing.eventAt;
	const position = orderAt(payload);

	// Older than the watermark is always stale.
	if (position < watermark) return true;

	if (position > watermark) return false;

	// Equal position: tie-break on product against the stored projection so
	// concurrent equal-time deliveries converge. Status is ordered by its own
	// fence, not here.
	const byProduct =
		payload.dodoProductId === (existing.dodoProductId ?? '')
			? 0
			: payload.dodoProductId < (existing.dodoProductId ?? '')
				? -1
				: 1;

	if (byProduct !== 0) return byProduct < 0;

	return false;
}

export function isStaleStatus({ existing, payload }: TransitionFences): boolean {
	if (!existing) return false;

	if (existing.dodoSubscriptionId !== payload.dodoSubscriptionId) return false;

	const watermark = existing.eventAt;
	const position = orderAt(payload);

	if (position < watermark) return true;

	if (position > watermark) return false;

	return statusRank(payload.status) < statusRank(existing.providerStatus ?? existing.status);
}

// Term fence on its own watermark so a historical failure cannot override a
// newer confirmed term.
export function isStaleTerm(
	existing: Doc<'subscriptions'> | null,
	payload: SubscriptionPayload
): boolean {
	if (!existing) return false;

	if (existing.dodoSubscriptionId !== payload.dodoSubscriptionId) return false;

	const termAt = existing.termEventAt ?? existing.payloadEventAt ?? existing.eventAt;

	if (
		existing.billingPeriodStart !== undefined &&
		payload.billingPeriodStart < existing.billingPeriodStart
	)
		return true;

	if (orderAt(payload) !== termAt) return orderAt(payload) < termAt;

	if (payload.billingPeriodStart !== existing.billingPeriodStart)
		return payload.billingPeriodStart < (existing.billingPeriodStart ?? -Infinity);

	return payload.billingPeriodEnd < (existing.billingPeriodEnd ?? -Infinity);
}

export function isStaleSchedule({ existing, payload }: TransitionFences): boolean {
	if (!existing || existing.dodoSubscriptionId !== payload.dodoSubscriptionId) return false;
	const watermark = existing.scheduleEventAt ?? existing.payloadEventAt ?? existing.eventAt;
	const position = orderAt(payload);

	if (position !== watermark) return position < watermark;

	if (payload.cancelAtNextBillingDate !== (existing.cancelAtNextBillingDate ?? false))
		return !payload.cancelAtNextBillingDate;

	return compareScheduledChanges(payload.scheduledChange, existing.scheduledChange ?? null) < 0;
}

/**
 * Whether a different Dodo subscription identity may take over the projection.
 * A currently billable or still-recoverable subscription blocks takeovers;
 * only authoritative non-recoverable termination permits a new purchase to
 * replace the identity. Superseded identities stay fenced regardless.
 */
export function identityTakeoverAllowed(
	existing: Doc<'subscriptions'> | null,
	payload: SubscriptionPayload
): 'apply' | 'competing' {
	if (!existing) return 'apply';

	// Operator grants without a Dodo identity are protected before this point;
	// reaching here means the row is Dodo-linked.
	if (!existing.dodoSubscriptionId) return 'apply';

	if (existing.dodoSubscriptionId === payload.dodoSubscriptionId) return 'apply';

	// Only provider-confirmed terminal statuses set terminalConfirmed; a
	// recoverable or locally-ended identity still blocks a competing purchase.
	if (existing.terminalConfirmed === true) return 'apply';

	return 'competing';
}

export type SubscriptionAccessSource = Pick<
	Doc<'subscriptions'>,
	| 'status'
	| 'dodoSubscriptionId'
	| 'billingPeriodStart'
	| 'billingPeriodEnd'
	| 'cancelAtNextBillingDate'
>;

type Access = { accessPhase: AccessPhase; accessEndsAt: number | undefined };

function access(accessPhase: AccessPhase, accessEndsAt: number | undefined): Access {
	return { accessPhase, accessEndsAt };
}

// Materialized access phase/deadline so reactive queries update and
// enforcement has a wall-clock fence.
export function computeAccess(subscription: SubscriptionAccessSource, now: number) {
	if (subscription.status !== 'active') return access('none', undefined);

	// Operator grants have no provider clock.
	if (!subscription.dodoSubscriptionId) return access('paid', undefined);

	// A Dodo-linked row without a confirmed term fails closed: there is no
	// term boundary to grant or bound paid access with.
	if (!Number.isFinite(subscription.billingPeriodEnd)) {
		return access('none', undefined);
	}

	const termEnd = subscription.billingPeriodEnd!;
	const termStart = subscription.billingPeriodStart;

	if (termStart !== undefined && (!Number.isFinite(termStart) || termStart >= termEnd)) {
		return access('none', termEnd);
	}

	if (termStart !== undefined && now < termStart) return access('none', termStart);

	if (now < termEnd) return access('paid', termEnd);

	if (subscription.cancelAtNextBillingDate) {
		// Keep the materialized deadline at the confirmed term end so a new
		// purchase after authoritative termination can advance it.
		return access('none', termEnd);
	}

	const graceEnd = termEnd + RENEWAL_GRACE_MS;

	if (now < graceEnd) return access('renewal_processing', graceEnd);

	return access('none', graceEnd);
}

/**
 * Whether an incoming payload actually transitions the projection. Compared
 * against the stored effective projection, so a redelivery that reorders
 * scheduled change/cancel flags alone still advances the payload watermark.
 */
export function projectionMatches(
	existing: Doc<'subscriptions'>,
	projected: {
		tier: string;
		status: string;
		dodoProductId: string;
		billingInterval: string;
		billingPeriodStart: number;
		billingPeriodEnd: number;
		cancelAtNextBillingDate: boolean;
		scheduledChange: ScheduledChange | null;
	}
): boolean {
	return (
		existing.tier === projected.tier &&
		existing.status === projected.status &&
		(existing.dodoProductId ?? '') === projected.dodoProductId &&
		(existing.billingInterval ?? '') === projected.billingInterval &&
		existing.billingPeriodStart === projected.billingPeriodStart &&
		existing.billingPeriodEnd === projected.billingPeriodEnd &&
		(existing.cancelAtNextBillingDate ?? false) === projected.cancelAtNextBillingDate &&
		compareScheduledChanges(existing.scheduledChange ?? null, projected.scheduledChange) === 0 &&
		(existing.scheduledChange?.id ?? null) === (projected.scheduledChange?.id ?? null)
	);
}
