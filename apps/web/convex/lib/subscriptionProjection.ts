import type { Doc } from '@convex/_generated/dataModel';
import {
	accessPhaseAt,
	isOperatorGrant,
	RENEWAL_GRACE_MS,
	type AccessClock
} from '@convex/lib/tiers';

/**
 * Webhooks order by the provider's event time. Reconciliation observations
 * order by when they were retrieved, and never stamp a watermark, so they
 * cannot fence out a delayed webhook.
 */
export type PayloadSource =
	{ source: 'webhook'; eventAt: number } | { source: 'observation'; observedAt: number };

export type SubscriptionPayload = PayloadSource & {
	dodoSubscriptionId: string;
	dodoProductId: string;
	dodoCustomerId: string;
	status:
		'active' | 'on_hold' | 'cancelled' | 'expired' | 'failed' | 'paused' | 'pending' | 'past_due';
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

export function payloadPosition(payload: PayloadSource): number {
	return payload.source === 'webhook' ? payload.eventAt : payload.observedAt;
}

type ScheduledChange = { id: string; productId: string; effectiveAt: number };

function compareScheduledChanges(a: ScheduledChange | null, b: ScheduledChange | null): number {
	if (!a && !b) return 0;

	if (!a) return -1;

	if (!b) return 1;

	if (a.effectiveAt !== b.effectiveAt) return a.effectiveAt - b.effectiveAt;

	if (a.productId !== b.productId) return a.productId < b.productId ? -1 : 1;

	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

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
	const position = payloadPosition(payload);

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
	const position = payloadPosition(payload);

	if (position < watermark) return true;

	if (position > watermark) return false;

	return statusRank(payload.status) < statusRank(existing.providerStatus ?? existing.status);
}

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

	if (payloadPosition(payload) !== termAt) return payloadPosition(payload) < termAt;

	if (payload.billingPeriodStart !== existing.billingPeriodStart)
		return payload.billingPeriodStart < (existing.billingPeriodStart ?? -Infinity);

	return payload.billingPeriodEnd < (existing.billingPeriodEnd ?? -Infinity);
}

export function isStaleSchedule({ existing, payload }: TransitionFences): boolean {
	if (!existing || existing.dodoSubscriptionId !== payload.dodoSubscriptionId) return false;
	const watermark = existing.scheduleEventAt ?? existing.payloadEventAt ?? existing.eventAt;
	const position = payloadPosition(payload);

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

/** The materialized access fields: the phase at `now` and when it next changes. */
export function computeAccess(subscription: AccessClock, now: number) {
	return {
		accessPhase: accessPhaseAt(subscription, now),
		accessEndsAt: accessBoundary(subscription, now)
	};
}

function accessBoundary(subscription: AccessClock, now: number): number | undefined {
	const { billingPeriodStart: termStart, billingPeriodEnd: termEnd } = subscription;

	if (
		subscription.status !== 'active' ||
		isOperatorGrant(subscription) ||
		termEnd === undefined ||
		!Number.isFinite(termEnd)
	)
		return undefined;

	if (termStart !== undefined && (!Number.isFinite(termStart) || termStart >= termEnd))
		return termEnd;

	if (termStart !== undefined && now < termStart) return termStart;

	if (now < termEnd || subscription.cancelAtNextBillingDate === true) return termEnd;

	return termEnd + RENEWAL_GRACE_MS;
}

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
