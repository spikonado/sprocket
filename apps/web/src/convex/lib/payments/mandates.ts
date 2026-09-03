import { v, type Infer } from 'convex/values';
import type { ActionCtx } from '@convex/_generated/server';
import { api, internal } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { isRunClaimLeaseActive } from '@convex/lib/runLease';
import {
	isMandateStatus,
	vMandateFrequency,
	vMandateScope,
	vMandateStatus,
	vMandateStatusResult,
	vMandateListResult
} from '@convex/lib/validators';
import { formatMoneyMinor, parseMoneyMinor } from '@convex/lib/payments/money';
import { listPravaMandates, pravaRequest, type PravaMandate } from '@convex/lib/payments/prava';

/** Only these mandate states can be charged or should be surfaced to the
 * agent/user. Cancelled/expired/consumed approvals must not match a local
 * setup during resolution. A stale same-merchant+amount approval would
 * otherwise poison the unique-match check forever. */
export const LIVE_MANDATE_STATUSES = new Set(['pending', 'active', 'paused']);

export async function activeActor(
	ctx: ActionCtx,
	args: { runId: Doc<'runs'>['_id']; claimId: string; executionSecret: string }
) {
	const actor = await ctx.runQuery(api.agentRuntime.completionActor, {
		runId: args.runId,
		executionSecret: args.executionSecret
	});
	if (actor.claimId !== args.claimId || !isRunClaimLeaseActive(actor, Date.now())) {
		throw new Error('Run is no longer active.');
	}
	return actor;
}

/** Any-scope (generic) mandates are one-time only. Prava rejects a recurring
 * frequency with any-scope, but enforce it locally so a one-time authorization
 * can never become a reusable recurring one. */
export function assertMandateFrequencyAllowed(args: {
	scope: Infer<typeof vMandateScope>;
	frequency: Infer<typeof vMandateFrequency>;
}) {
	if (args.scope === 'any' && args.frequency !== 'one_time') {
		throw new Error('Any-merchant mandates must be one-time.');
	}
}

export const mandateDoc = v.object({
	_id: v.id('mandates'),
	_creationTime: v.number(),
	userId: v.string(),
	pravaMandateId: v.optional(v.string()),
	pravaSessionId: v.string(),
	merchantName: v.optional(v.string()),
	merchantUrl: v.optional(v.string()),
	countryCode: v.optional(v.string()),
	amountCap: v.number(),
	currency: v.string(),
	frequency: vMandateFrequency,
	scope: vMandateScope,
	status: vMandateStatus,
	description: v.string(),
	approvalUrl: v.string(),
	validUntil: v.optional(v.string()),
	renewsAt: v.optional(v.string()),
	remaining: v.optional(v.number()),
	createdAt: v.number(),
	updatedAt: v.number()
});

function pravaStatusToLocal(status: string | undefined): Infer<typeof vMandateStatus> | undefined {
	return isMandateStatus(status) ? status : undefined;
}

export function mandateSyncArgs(
	mandateId: Id<'mandates'>,
	userId: string,
	mandate: PravaMandate & { id: string }
) {
	return {
		mandateId,
		userId,
		pravaMandateId: mandate.id,
		status: pravaStatusToLocal(mandate.status),
		remaining: mandate.remaining == null ? undefined : parseMoneyMinor(mandate.remaining),
		validUntil: mandate.validUntil ?? undefined,
		renewsAt: mandate.renewsAt ?? undefined
	};
}

/** Overlay freshly synced Prava fields onto the local mandate doc. */
export function withMandateSync(
	mandate: Doc<'mandates'>,
	sync: ReturnType<typeof mandateSyncArgs>
): Doc<'mandates'> {
	return {
		...mandate,
		pravaMandateId: sync.pravaMandateId,
		status: sync.status ?? mandate.status,
		remaining: sync.remaining ?? mandate.remaining,
		validUntil: sync.validUntil ?? mandate.validUntil,
		renewsAt: sync.renewsAt ?? mandate.renewsAt
	};
}

export function mandateStatusResult(mandate: Doc<'mandates'>): Infer<typeof vMandateStatusResult> {
	return {
		mandateId: mandate._id,
		pravaMandateId: mandate.pravaMandateId,
		status: mandate.status,
		description: mandate.description,
		merchantName: mandate.merchantName,
		amountCap: formatMoneyMinor(mandate.amountCap),
		remaining: mandate.remaining !== undefined ? formatMoneyMinor(mandate.remaining) : undefined,
		currency: mandate.currency,
		frequency: mandate.frequency,
		scope: mandate.scope,
		approvalUrl: mandate.approvalUrl,
		validUntil: mandate.validUntil,
		renewsAt: mandate.renewsAt
	};
}

/** True when a live Prava mandate uniquely matches a local setup's merchant,
 * amount cap, and currency. Used both for charge-time resolution and for
 * linking local rows after the owner approves in a new tab. */
function isMatchingLivePravaMandate(
	mandate: Doc<'mandates'>,
	prava: PravaMandate
): boolean {
	if (!prava.id) return false;
	if (!LIVE_MANDATE_STATUSES.has(prava.status ?? '')) return false;
	// A different scope or cadence is a different authorization even when the
	// merchant name and cap coincide.
	if (prava.merchantScope !== undefined && prava.merchantScope !== mandate.scope) return false;
	if (prava.recurringFrequency !== undefined && prava.recurringFrequency !== mandate.frequency) {
		return false;
	}
	// A mandate approved in another currency is a different authorization;
	// never resolve (and later charge) it for this setup.
	if ((prava.currency ?? '').toUpperCase() !== mandate.currency.toUpperCase()) return false;
	const approvedMinor = prava.approvedAmount ? parseMoneyMinor(prava.approvedAmount) : undefined;
	if (approvedMinor === undefined || approvedMinor !== mandate.amountCap) return false;
	if (mandate.scope === 'listed') {
		const localName = mandate.merchantName?.trim();
		if (!localName) return false;
		return (prava.merchantName ?? '').toLowerCase() === localName.toLowerCase();
	}
	return true;
}

function matchingLivePravaMandates(
	mandate: Doc<'mandates'>,
	list: PravaMandate[],
	claimedIds?: ReadonlySet<string>
): Array<PravaMandate & { id: string }> {
	return list
		.filter((m) => {
			if (!m.id || claimedIds?.has(m.id)) return false;
			return isMatchingLivePravaMandate(mandate, m);
		})
		.map((m) => ({ ...m, id: m.id! }));
}

function isUnresolvedLocal(mandate: Doc<'mandates'>): boolean {
	return !mandate.pravaMandateId && LIVE_MANDATE_STATUSES.has(mandate.status);
}

/** A Prava mandate is only safe to bind when it uniquely matches this local
 * setup and no other unresolved local setup also matches it. Otherwise two
 * same-merchant/amount pending rows can steal each other's approval. */
function uniquelyAttributablePravaMandate(
	mandate: Doc<'mandates'>,
	list: PravaMandate[],
	allLocal: Doc<'mandates'>[]
):
	| { kind: 'matched'; mandate: PravaMandate & { id: string } }
	| { kind: 'none' }
	| { kind: 'ambiguous' } {
	const claimed = new Set(
		allLocal
			.filter((row) => row.pravaMandateId && row._id !== mandate._id)
			.map((row) => row.pravaMandateId)
			.filter((id): id is string => id !== undefined)
	);
	const matches = matchingLivePravaMandates(mandate, list, claimed);
	if (matches.length === 0) return { kind: 'none' };
	if (matches.length > 1) return { kind: 'ambiguous' };
	const candidate = matches[0];
	const contested = allLocal.some(
		(peer) =>
			peer._id !== mandate._id &&
			isUnresolvedLocal(peer) &&
			isMatchingLivePravaMandate(peer, candidate)
	);
	if (contested) return { kind: 'ambiguous' };
	return { kind: 'matched', mandate: candidate };
}

/** Resolve the Prava-side mandate id for a locally stored mandate. It only
 * exists once the owner approves, so resolve lazily by listing the user's
 * mandates and matching this setup's merchant + cap, then persist it. */
export async function resolvePravaMandate(
	ctx: ActionCtx,
	userId: string,
	mandate: Doc<'mandates'>
): Promise<PravaMandate & { id: string }> {
	if (mandate.pravaMandateId) {
		const found = await pravaRequest<PravaMandate>(
			`/v1/mandates/${encodeURIComponent(mandate.pravaMandateId)}`
		);
		return { ...found, id: mandate.pravaMandateId };
	}
	const list = await listPravaMandates(userId, false);
	const local = await ctx.runQuery(internal.payments.listLocalMandates, { userId });
	const match = uniquelyAttributablePravaMandate(mandate, list, local);
	// Require a unique live match. Charging an arbitrary same-merchant+amount
	// approval could settle against the wrong authorization. Prava mandates
	// don't carry their setup session id, so there is no stronger link to
	// prefer on.
	if (match.kind === 'none') {
		throw new Error('Mandate is not yet approved.');
	}
	if (match.kind === 'ambiguous') {
		throw new Error(
			'Cannot uniquely match this setup to an approved mandate; resolve the ambiguity before charging.'
		);
	}
	const resolved = match.mandate;
	await ctx.runMutation(
		internal.payments.syncMandate,
		mandateSyncArgs(mandate._id, userId, resolved)
	);
	return resolved;
}

/** Join Prava's live mandates to local rows. After new-tab approval the local
 * row still lacks pravaMandateId, so uniquely match unresolved locals against
 * the live list and persist the link; otherwise settings can't pause/cancel. */
async function linkLocalMandates(
	ctx: ActionCtx,
	userId: string,
	list: PravaMandate[]
): Promise<{
	localByPravaId: Map<string, Id<'mandates'>>;
	localById: Map<Id<'mandates'>, Doc<'mandates'>>;
}> {
	const local = await ctx.runQuery(internal.payments.listLocalMandates, { userId });
	const localById = new Map(local.map((m) => [m._id, m]));
	const localByPravaId = new Map(
		local
			.filter((m): m is typeof m & { pravaMandateId: string } => m.pravaMandateId !== undefined)
			.map((m) => [m.pravaMandateId, m._id])
	);
	for (const mandate of local.filter(isUnresolvedLocal)) {
		const match = uniquelyAttributablePravaMandate(mandate, list, local);
		if (match.kind !== 'matched') continue;
		const sync = mandateSyncArgs(mandate._id, userId, match.mandate);
		await ctx.runMutation(internal.payments.syncMandate, sync);
		const linked = withMandateSync(mandate, sync);
		localByPravaId.set(sync.pravaMandateId, mandate._id);
		localById.set(mandate._id, linked);
		// Keep later uniqueness checks aware of the link we just persisted.
		local[local.indexOf(mandate)] = linked;
	}
	return { localByPravaId, localById };
}

/** List the user's live Prava mandates joined to local rows (linking any
 * still-unresolved setups) so each entry carries the local mandateId the
 * lifecycle action needs. Entries without a local row (e.g. approved
 * elsewhere) are still listed, just without a mandateId. */
export async function listLinkedMandates(
	ctx: ActionCtx,
	userId: string
): Promise<Infer<typeof vMandateListResult>> {
	const list = (await listPravaMandates(userId, false)).filter((m) =>
		LIVE_MANDATE_STATUSES.has(m.status ?? '')
	);
	const { localByPravaId, localById } = await linkLocalMandates(ctx, userId, list);
	return {
		mandates: list.map((m) => {
			const mandateId = m.id ? localByPravaId.get(m.id) : undefined;
			const local = mandateId ? localById.get(mandateId) : undefined;
			return {
				mandateId,
				pravaMandateId: m.id ?? '',
				status: m.status ?? 'unknown',
				description: local?.description,
				merchantName: m.merchantName ?? local?.merchantName ?? undefined,
				approvedAmount: m.approvedAmount ?? '',
				remaining: m.remaining ?? undefined,
				currency: m.currency ?? '',
				validUntil: m.validUntil ?? undefined,
				renewsAt: m.renewsAt ?? undefined
			};
		})
	};
}
