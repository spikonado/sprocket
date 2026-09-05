import { v, type Infer } from 'convex/values';
import type { MutationCtx } from '@convex/_generated/server';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { vMandateChargeStatus, vMandateReportOutcome } from '@convex/lib/validators';
import { formatMoneyMinor, parseMoneyMinor } from '@convex/lib/payments/money';

export const REPORT_CLAIM_STALE_MS = 60_000;
export const CHARGE_CLAIM_STALE_MS = 60_000;

export const chargeDoc = v.object({
	_id: v.id('mandateCharges'),
	_creationTime: v.number(),
	mandateId: v.id('mandates'),
	runId: v.id('runs'),
	userId: v.string(),
	pravaTransactionId: v.optional(v.string()),
	amount: v.number(),
	currency: v.string(),
	description: v.string(),
	reference: v.optional(v.string()),
	status: vMandateChargeStatus,
	reportOutcome: v.optional(vMandateReportOutcome),
	reportedAt: v.optional(v.number()),
	reportingStartedAt: v.optional(v.number()),
	chargingStartedAt: v.optional(v.number()),
	providerRequestedAt: v.optional(v.number()),
	reportRetrierRunId: v.optional(v.string()),
	createdAt: v.number(),
	updatedAt: v.number()
});

export type ChargeStatusPatch = {
	status: 'completed' | 'declined' | 'failed';
	chargingStartedAt: undefined;
	updatedAt: number;
	providerRequestedAt?: undefined;
};

export type ChargeReportPostArgs = {
	chargeId: Id<'mandateCharges'>;
	userId: string;
	outcome: Infer<typeof vMandateReportOutcome>;
	amountPaid?: string;
};

export type ChargeReportReleasePatch = {
	reportingStartedAt: undefined;
	updatedAt: number;
	reportOutcome?: undefined;
	reportRetrierRunId?: undefined;
};

export type MandateChargeRequest = {
	amount: string;
	reference?: string;
};

export type MandateReportRequest = {
	txn_status: 'APPROVED' | 'DECLINED';
	txn_type: 'PURCHASE';
	amount_paid?: string;
};

/** Fail fast on a charge the mandate obviously can't authorize. Prava is
 * still the authoritative limit enforcer at the card network. These checks
 * only stop clearly wrong requests from producing misleading local records. */
export function assertChargeable(
	mandate: Doc<'mandates'>,
	args: { amount: string; currency: string }
): void {
	if (args.currency.trim().toUpperCase() !== mandate.currency.toUpperCase()) {
		throw new Error(`Charge currency must match the mandate's ${mandate.currency}.`);
	}
	const amount = parseMoneyMinor(args.amount);
	if (amount === undefined || amount <= 0) {
		throw new Error('Charge amount must be a positive decimal string.');
	}
	if (amount > mandate.amountCap) {
		throw new Error(
			`Charge amount exceeds the mandate's ${formatMoneyMinor(mandate.amountCap)} cap.`
		);
	}
	if (mandate.remaining !== undefined && amount > mandate.remaining) {
		throw new Error(
			`Charge amount exceeds the mandate's remaining ${formatMoneyMinor(mandate.remaining)}.`
		);
	}
}

export async function ownedCharge(
	ctx: MutationCtx,
	chargeId: Id<'mandateCharges'>,
	userId: string
): Promise<Doc<'mandateCharges'>> {
	const charge = await ctx.db.get('mandateCharges', chargeId);
	if (!charge || charge.userId !== userId) {
		throw new Error('Charge not found.');
	}
	return charge;
}

export function statusForOutcome(
	outcome: Infer<typeof vMandateReportOutcome>
): 'completed' | 'declined' {
	return outcome === 'approved' ? 'completed' : 'declined';
}
