import { ActionRetrier, onCompleteValidator, type RunId } from '@convex-dev/action-retrier';
import { v, type Infer, type ObjectType } from 'convex/values';
import {
	action,
	env,
	internalAction,
	internalMutation,
	internalQuery,
	type ActionCtx,
	type MutationCtx
} from '@convex/_generated/server';
import { api, components, internal } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { distinctOwnerKeys, getUserId, matchesOwner, pickPrimaryUser } from '@convex/lib/auth';
import { resolveStoredOwnerKeys } from '@convex/lib/access';
import { isRunClaimLeaseActive } from '@convex/lib/runLease';
import { toAgentToolConvexError } from '@convex/lib/agentErrors';
import { unsupportedClient } from '@convex/lib/unsupportedClient';
import {
	isMandateStatus,
	vMandateChargeStatus,
	vMandateFrequency,
	vMandateReportOutcome,
	vMandateScope,
	vMandateStatus,
	vMandateSetupResult,
	vMandateStatusResult,
	vMandateListResult,
	vMandateChargeResult,
	vMandateReportResult
} from '@convex/lib/validators';

const REPORT_CLAIM_STALE_MS = 60_000;
const CHARGE_CLAIM_STALE_MS = 60_000;

const reportRetrier = new ActionRetrier(components.actionRetrier, {
	initialBackoffMs: 250,
	base: 2,
	maxFailures: 4
});

type PravaConfig = {
	baseUrl: string;
	secretKey: string;
};

function pravaConfig(): PravaConfig {
	const secretKey = env.PRAVA_SECRET_KEY?.trim();
	if (!secretKey) {
		throw new Error('PRAVA_SECRET_KEY is not configured.');
	}
	return {
		baseUrl: env.PRAVA_BACKEND_URL,
		secretKey
	};
}

async function pravaRequest<T>(path: string, init?: RequestInit): Promise<T> {
	const { baseUrl, secretKey } = pravaConfig();
	const headers = new Headers(init?.headers);
	headers.set('Authorization', `Bearer ${secretKey}`);
	if (init?.body) headers.set('Content-Type', 'application/json');
	const response = await fetch(`${baseUrl}${path}`, {
		...init,
		headers
	});
	if (!response.ok) {
		const details = await response.text();
		let message = details;
		try {
			// SAFETY: Prava errors share one documented envelope
			// ({error:{code,message,details}}); both fields are optional-checked
			// before use and anything else keeps the raw body as the message.
			const parsed = JSON.parse(details) as { error?: { code?: string; message?: string } };
			if (parsed.error?.code || parsed.error?.message) {
				message = [parsed.error.code, parsed.error.message].filter(Boolean).join(' - ');
			}
		} catch {
			// Not JSON; surface the raw body.
		}
		throw new Error(`Prava request failed (${response.status})${message ? `: ${message}` : '.'}`);
	}
	const body = await response.text();
	// SAFETY: unchecked decode of the trusted Prava API response into its documented contract T.
	return (body ? JSON.parse(body) : undefined) as T;
}

/** A first-time customer has no Prava customer record yet, so listing their
 * mandates 404s with CUSTOMER_NOT_FOUND; treat that as "no mandates yet"
 * rather than an error. */
function isPravaCustomerNotFound(error: Error): boolean {
	return error.message.includes('CUSTOMER_NOT_FOUND');
}

/** List a customer's mandates from Prava, treating a first-time customer's
 * CUSTOMER_NOT_FOUND 404 as an empty list rather than an error. */
async function listPravaMandates(userId: string, standingOnly: boolean): Promise<PravaMandate[]> {
	try {
		const list = await pravaRequest<{ mandates?: PravaMandate[] }>(
			`/v1/mandates?customer_id=${encodeURIComponent(userId)}${standingOnly ? '&standing_only=true' : ''}`
		);
		return list.mandates ?? [];
	} catch (error) {
		if (error instanceof Error && isPravaCustomerNotFound(error)) {
			return [];
		}
		throw error;
	}
}

/** Only these mandate states can be charged or should be surfaced to the
 * agent/user. Cancelled/expired/consumed approvals must not match a local
 * setup during resolution. A stale same-merchant+amount approval would
 * otherwise poison the unique-match check forever. */
const LIVE_MANDATE_STATUSES = new Set(['pending', 'active', 'paused']);

async function activeActor(
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
function assertMandateFrequencyAllowed(args: {
	scope: Infer<typeof vMandateScope>;
	frequency: Infer<typeof vMandateFrequency>;
}) {
	if (args.scope === 'any' && args.frequency !== 'one_time') {
		throw new Error('Any-merchant mandates must be one-time.');
	}
}

const mandateDoc = v.object({
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

const chargeDoc = v.object({
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

type MandateSyncPatch = {
	updatedAt: number;
	pravaMandateId?: string;
	status?: Infer<typeof vMandateStatus>;
	remaining?: number;
	validUntil?: string;
	renewsAt?: string;
};

type ChargeStatusPatch = {
	status: 'completed' | 'declined' | 'failed';
	chargingStartedAt: undefined;
	updatedAt: number;
	providerRequestedAt?: undefined;
};

type ChargeReportPostArgs = {
	chargeId: Id<'mandateCharges'>;
	userId: string;
	outcome: Infer<typeof vMandateReportOutcome>;
	amountPaid?: string;
};

type ChargeReportReleasePatch = {
	reportingStartedAt: undefined;
	updatedAt: number;
	reportOutcome?: undefined;
	reportRetrierRunId?: undefined;
};

type MandateSetupRequest = {
	intent: 'mandate_setup';
	recurring_frequency: Infer<typeof vMandateFrequency>;
	merchant_scope: Infer<typeof vMandateScope>;
	max_charges?: number;
	valid_until?: string;
};

type MandateChargeRequest = {
	amount: string;
	reference?: string;
};

type MandateReportRequest = {
	txn_status: 'APPROVED' | 'DECLINED';
	txn_type: 'PURCHASE';
	amount_paid?: string;
};

type PravaMandate = {
	id?: string;
	status?: string;
	recurringFrequency?: string;
	merchantScope?: string;
	remaining?: string | null;
	approvedAmount?: string;
	currency?: string;
	merchantName?: string | null;
	validUntil?: string | null;
	renewsAt?: string | null;
};

function pravaStatusToLocal(status: string | undefined): Infer<typeof vMandateStatus> | undefined {
	return isMandateStatus(status) ? status : undefined;
}

/** Parse a Prava/agent decimal money string into integer minor units (cents).
 * Fixed-point, so "0.1" + "0.2" class errors can't leak into comparisons. */
function parseMoneyMinor(value: string): number | undefined {
	const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
	if (!match) return undefined;
	const units = Number(match[1]);
	const fraction = Number((match[2] ?? '').padEnd(2, '0') || '0');
	if (!Number.isSafeInteger(units) || !Number.isSafeInteger(fraction)) return undefined;
	const minor = units * 100 + fraction;
	return Number.isSafeInteger(minor) ? minor : undefined;
}

function requireMoneyMinor(value: string, label: string): number {
	const minor = parseMoneyMinor(value);
	if (minor === undefined) {
		throw new Error(`${label} must be a non-negative decimal amount.`);
	}
	return minor;
}

/** Format integer minor units for Prava/agent/UI decimal strings. Minor units
 * only enter through parseMoneyMinor, so they are always non-negative. */
function formatMoneyMinor(minor: number): string {
	return `${Math.floor(minor / 100)}.${(minor % 100).toString().padStart(2, '0')}`;
}

/** Fail fast on a charge the mandate obviously can't authorize. Prava is
 * still the authoritative limit enforcer at the card network. These checks
 * only stop clearly wrong requests from producing misleading local records. */
function assertChargeable(
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

async function ownedCharge(
	ctx: MutationCtx,
	chargeId: Id<'mandateCharges'>,
	userId: string
): Promise<Doc<'mandateCharges'>> {
	const charge = await ctx.db.get('mandateCharges', chargeId);
	const keys = await resolveStoredOwnerKeys(ctx.db, userId);
	if (!charge || !matchesOwner(charge.userId, keys)) {
		throw new Error('Charge not found.');
	}
	return charge;
}

function statusForOutcome(outcome: Infer<typeof vMandateReportOutcome>): 'completed' | 'declined' {
	return outcome === 'approved' ? 'completed' : 'declined';
}

function mandateSyncArgs(
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
function withMandateSync(
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

function mandateStatusResult(mandate: Doc<'mandates'>): Infer<typeof vMandateStatusResult> {
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

// ---------------------------------------------------------------------------
// Internal queries / mutations
// ---------------------------------------------------------------------------

export const insertMandate = internalMutation({
	args: {
		userId: v.string(),
		pravaSessionId: v.string(),
		merchantName: v.optional(v.string()),
		merchantUrl: v.optional(v.string()),
		countryCode: v.optional(v.string()),
		amountCap: v.string(),
		currency: v.string(),
		frequency: vMandateFrequency,
		scope: vMandateScope,
		description: v.string(),
		approvalUrl: v.string()
	},
	returns: v.id('mandates'),
	handler: async (ctx, args) => {
		try {
			const description = args.description.trim();
			if (!description) {
				throw new Error('Mandate description is required.');
			}
			const now = Date.now();
			return await ctx.db.insert('mandates', {
				userId: args.userId,
				pravaSessionId: args.pravaSessionId,
				merchantName: args.merchantName,
				merchantUrl: args.merchantUrl,
				countryCode: args.countryCode,
				amountCap: requireMoneyMinor(args.amountCap, 'Amount cap'),
				currency: args.currency,
				frequency: args.frequency,
				scope: args.scope,
				description,
				approvalUrl: args.approvalUrl,
				status: 'pending',
				createdAt: now,
				updatedAt: now
			});
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

export const getOwnedMandate = internalQuery({
	args: { mandateId: v.id('mandates'), userId: v.string() },
	returns: v.union(mandateDoc, v.null()),
	handler: async (ctx, args) => {
		const mandate = await ctx.db.get('mandates', args.mandateId);
		if (!mandate) return null;
		const keys = await resolveStoredOwnerKeys(ctx.db, args.userId);
		return matchesOwner(mandate.userId, keys) ? mandate : null;
	}
});

/** The user's WorkOS email, synced onto their users row by
 * ensureCurrentUser. Executor actions have no WorkOS identity, so
 * capability-gated code reads the email from here instead of ctx.auth. */
export const getUserEmail = internalQuery({
	args: { userId: v.string() },
	returns: v.string(),
	handler: async (ctx, args) => {
		// Executor userIds are stored rows that may hold the legacy subject or
		// the canonical tokenIdentifier, so match against both columns.
		const rows = await ctx.db
			.query('users')
			.withIndex('by_subject', (query) => query.eq('subject', args.userId))
			.collect();
		if (rows[0]) {
			return pickPrimaryUser(rows)!.email;
		}
		const byToken = await ctx.db
			.query('users')
			.withIndex('by_tokenIdentifier', (query) => query.eq('tokenIdentifier', args.userId))
			.unique();
		if (byToken) {
			return byToken.email;
		}
		throw new Error(`No user record for ${args.userId}.`);
	}
});

export const listLocalMandates = internalQuery({
	args: { userId: v.string() },
	returns: v.array(mandateDoc),
	handler: async (ctx, args) => {
		const keys = await resolveStoredOwnerKeys(ctx.db, args.userId);
		return (
			await Promise.all(
				distinctOwnerKeys(keys).map((key) =>
					ctx.db
						.query('mandates')
						.withIndex('by_user', (query) => query.eq('userId', key))
						.collect()
				)
			)
		).flat();
	}
});

export const syncMandate = internalMutation({
	args: {
		mandateId: v.id('mandates'),
		userId: v.string(),
		pravaMandateId: v.optional(v.string()),
		status: v.optional(vMandateStatus),
		remaining: v.optional(v.number()),
		validUntil: v.optional(v.string()),
		renewsAt: v.optional(v.string())
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		try {
			const mandate = await ctx.db.get('mandates', args.mandateId);
			const keys = await resolveStoredOwnerKeys(ctx.db, args.userId);
			if (!mandate || !matchesOwner(mandate.userId, keys)) {
				throw new Error('Mandate not found.');
			}
			const patch: MandateSyncPatch = { updatedAt: Date.now() };
			if (args.pravaMandateId !== undefined && !mandate.pravaMandateId) {
				patch.pravaMandateId = args.pravaMandateId;
			}
			// Never rewind a terminal status.
			const terminal = new Set(['consumed', 'cancelled', 'expired']);
			if (args.status && !(terminal.has(mandate.status) && args.status !== mandate.status)) {
				patch.status = args.status;
			}
			if (args.remaining !== undefined) patch.remaining = args.remaining;
			if (args.validUntil !== undefined) patch.validUntil = args.validUntil;
			if (args.renewsAt !== undefined) patch.renewsAt = args.renewsAt;
			await ctx.db.patch('mandates', args.mandateId, patch);
			return null;
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

const reserveChargeResult = v.union(
	v.object({
		kind: v.literal('reserved'),
		chargeId: v.id('mandateCharges')
	}),
	v.object({
		kind: v.literal('existing'),
		chargeId: v.id('mandateCharges'),
		transactionId: v.string()
	}),
	v.object({ kind: v.literal('inFlight') })
);

/** Atomically reserve a charge row. When `reference` is set, (mandateId,
 * reference) is an idempotency key: a completed prior charge returns its
 * non-sensitive handle (credentials are never persisted), a live in-flight
 * claim reports inFlight, and only a fresh/stale reservation proceeds to
 * Prava. */
export const reserveCharge = internalMutation({
	args: {
		mandateId: v.id('mandates'),
		runId: v.id('runs'),
		userId: v.string(),
		amount: v.string(),
		currency: v.string(),
		description: v.string(),
		reference: v.optional(v.string())
	},
	returns: reserveChargeResult,
	handler: async (ctx, args) => {
		try {
			const amount = requireMoneyMinor(args.amount, 'Charge amount');
			const reference = args.reference?.trim() || undefined;
			const now = Date.now();

			if (reference !== undefined) {
				const matches = await ctx.db
					.query('mandateCharges')
					.withIndex('by_mandate_reference', (query) =>
						query.eq('mandateId', args.mandateId).eq('reference', reference)
					)
					.take(2);
				if (matches.length > 1) {
					throw new Error('Charge reference matches multiple existing charges.');
				}
				const existing = matches[0];
				if (existing) {
					const keys = await resolveStoredOwnerKeys(ctx.db, args.userId);
					if (!matchesOwner(existing.userId, keys)) {
						throw new Error('Charge not found.');
					}
					if (existing.amount !== amount || existing.currency !== args.currency) {
						throw new Error(
							'Charge reference was already used with a different amount or currency.'
						);
					}
					if (existing.pravaTransactionId) {
						return {
							kind: 'existing' as const,
							chargeId: existing._id,
							transactionId: existing.pravaTransactionId
						};
					}
					if (existing.providerRequestedAt !== undefined) {
						// Ambiguous delivery: the provider POST may have committed.
						// Never reclaim for another charge. That would double-bill.
						throw new Error(
							'A previous charge attempt for this reference may have already been submitted to Prava; refusing to charge again.'
						);
					}
					if (existing.status === 'failed') {
						await ctx.db.patch('mandateCharges', existing._id, {
							runId: args.runId,
							description: args.description,
							status: 'awaiting_result',
							pravaTransactionId: undefined,
							providerRequestedAt: undefined,
							chargingStartedAt: now,
							updatedAt: now
						});
						return { kind: 'reserved' as const, chargeId: existing._id };
					}
					if (
						existing.chargingStartedAt !== undefined &&
						now - existing.chargingStartedAt <= CHARGE_CLAIM_STALE_MS
					) {
						return { kind: 'inFlight' as const };
					}
					// Abandoned reservation that never reached Prava: reclaim.
					await ctx.db.patch('mandateCharges', existing._id, {
						runId: args.runId,
						description: args.description,
						status: 'awaiting_result',
						chargingStartedAt: now,
						updatedAt: now
					});
					return { kind: 'reserved' as const, chargeId: existing._id };
				}
			}

			const chargeId = await ctx.db.insert('mandateCharges', {
				mandateId: args.mandateId,
				runId: args.runId,
				userId: args.userId,
				amount,
				currency: args.currency,
				description: args.description,
				reference,
				status: 'awaiting_result',
				chargingStartedAt: now,
				createdAt: now,
				updatedAt: now
			});
			return { kind: 'reserved' as const, chargeId };
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

export const markChargeProviderRequested = internalMutation({
	args: { chargeId: v.id('mandateCharges'), userId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		await ownedCharge(ctx, args.chargeId, args.userId);
		await ctx.db.patch('mandateCharges', args.chargeId, {
			providerRequestedAt: Date.now(),
			updatedAt: Date.now()
		});
		return null;
	}
});

export const completeCharge = internalMutation({
	args: {
		chargeId: v.id('mandateCharges'),
		userId: v.string(),
		pravaTransactionId: v.string()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const charge = await ownedCharge(ctx, args.chargeId, args.userId);
		await ctx.db.patch('mandateCharges', args.chargeId, {
			pravaTransactionId: args.pravaTransactionId,
			status: charge.status === 'failed' ? 'failed' : 'awaiting_result',
			chargingStartedAt: undefined,
			updatedAt: Date.now()
		});
		return null;
	}
});

export const releaseChargeReservation = internalMutation({
	args: { chargeId: v.id('mandateCharges'), userId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const charge = await ownedCharge(ctx, args.chargeId, args.userId);
		if (!charge.pravaTransactionId) {
			// Drop the live claim so callers aren't stuck in inFlight, but keep
			// providerRequestedAt, since an ambiguous POST must not be reclaimed.
			await ctx.db.patch('mandateCharges', args.chargeId, {
				chargingStartedAt: undefined,
				updatedAt: Date.now()
			});
		}
		return null;
	}
});

export const getOwnedCharge = internalQuery({
	args: { chargeId: v.id('mandateCharges'), userId: v.string() },
	returns: v.union(chargeDoc, v.null()),
	handler: async (ctx, args) => {
		const charge = await ctx.db.get('mandateCharges', args.chargeId);
		if (!charge) return null;
		const keys = await resolveStoredOwnerKeys(ctx.db, args.userId);
		return matchesOwner(charge.userId, keys) ? charge : null;
	}
});

export const updateChargeStatus = internalMutation({
	args: {
		chargeId: v.id('mandateCharges'),
		userId: v.string(),
		status: v.union(v.literal('completed'), v.literal('declined'), v.literal('failed'))
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const charge = await ownedCharge(ctx, args.chargeId, args.userId);
		if (!charge.reportedAt) {
			const chargePatch: ChargeStatusPatch = {
				status: args.status,
				chargingStartedAt: undefined,
				updatedAt: Date.now()
			};
			// Definitive provider failure (or local fail); allow a later
			// same-reference retry to reclaim the row.
			if (args.status === 'failed') chargePatch.providerRequestedAt = undefined;
			await ctx.db.patch('mandateCharges', args.chargeId, chargePatch);
		}
		return null;
	}
});

/** Atomically claim the right to report a charge to Prava. 'claimed' lets this
 * caller proceed; 'already' means a terminal report already happened; 'inFlight'
 * means a live (non-stale) claim is in flight and no report has completed yet. */
export const claimChargeReport = internalMutation({
	args: {
		chargeId: v.id('mandateCharges'),
		userId: v.string(),
		outcome: vMandateReportOutcome
	},
	returns: v.union(v.literal('claimed'), v.literal('already'), v.literal('inFlight')),
	handler: async (ctx, args) => {
		try {
			const charge = await ownedCharge(ctx, args.chargeId, args.userId);
			if (charge.reportedAt) {
				return 'already';
			}
			// The first-claimed outcome is immutable. A conflicting report must
			// never be sent. A crash between the provider POST and the local
			// finalize would otherwise let a retry overwrite the outcome and POST
			// the opposite terminal state to the card network.
			if (charge.reportOutcome && charge.reportOutcome !== args.outcome) {
				throw new Error(
					`Charge already has a ${charge.reportOutcome} report in progress; the outcome cannot be changed.`
				);
			}
			if (charge.reportingStartedAt) {
				// A claim newer than the report window belongs to a live concurrent
				// caller and has not completed, so say so rather than claim success. An
				// older one is abandoned (its caller died), so reclaim it and re-send;
				// the provider report is idempotent on the transaction id.
				if (Date.now() - charge.reportingStartedAt <= REPORT_CLAIM_STALE_MS) {
					return 'inFlight';
				}
			}
			await ctx.db.patch('mandateCharges', args.chargeId, {
				reportingStartedAt: Date.now(),
				reportOutcome: args.outcome,
				updatedAt: Date.now()
			});
			return 'claimed';
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

export const releaseChargeReport = internalMutation({
	args: {
		chargeId: v.id('mandateCharges'),
		userId: v.string(),
		/** Only clear the bound outcome when no report request can have reached
		 * Prava yet (e.g. missing local ids). After a transport error the remote
		 * may already have committed, so the first-claimed outcome must stick. */
		clearOutcome: v.optional(v.boolean())
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const charge = await ownedCharge(ctx, args.chargeId, args.userId);
		if (!charge.reportedAt) {
			const reportPatch: ChargeReportReleasePatch = {
				reportingStartedAt: undefined,
				updatedAt: Date.now()
			};
			if (args.clearOutcome) reportPatch.reportOutcome = undefined;
			await ctx.db.patch('mandateCharges', args.chargeId, reportPatch);
		}
		return null;
	}
});

export const finishChargeReport = internalMutation({
	args: {
		chargeId: v.id('mandateCharges'),
		userId: v.string(),
		status: v.union(v.literal('completed'), v.literal('declined'))
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const charge = await ownedCharge(ctx, args.chargeId, args.userId);
		if (!charge.reportedAt) {
			const now = Date.now();
			await ctx.db.patch('mandateCharges', args.chargeId, {
				status: args.status,
				reportingStartedAt: undefined,
				reportOutcome: undefined,
				reportedAt: now,
				updatedAt: now
			});
		}
		return null;
	}
});

export const startChargeReportRetrier = internalMutation({
	args: {
		chargeId: v.id('mandateCharges'),
		userId: v.string(),
		outcome: vMandateReportOutcome,
		amountPaid: v.optional(v.string())
	},
	returns: v.string(),
	handler: async (ctx, args): Promise<string> => {
		const charge = await ownedCharge(ctx, args.chargeId, args.userId);
		const postArgs: ChargeReportPostArgs = {
			chargeId: charge._id,
			userId: args.userId,
			outcome: args.outcome
		};
		if (args.amountPaid !== undefined) postArgs.amountPaid = args.amountPaid;
		const retrierRunId = await reportRetrier.run(
			ctx,
			internal.payments.postChargeReport,
			postArgs,
			{ onComplete: internal.payments.completeRetriedChargeReport }
		);
		await ctx.db.patch('mandateCharges', charge._id, {
			reportRetrierRunId: retrierRunId,
			updatedAt: Date.now()
		});
		return retrierRunId;
	}
});

export const postChargeReport = internalAction({
	args: {
		chargeId: v.id('mandateCharges'),
		userId: v.string(),
		outcome: vMandateReportOutcome,
		amountPaid: v.optional(v.string())
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const charge = await ctx.runQuery(internal.payments.getOwnedCharge, {
			chargeId: args.chargeId,
			userId: args.userId
		});
		if (!charge || charge.reportedAt) {
			return null;
		}
		if (!charge.pravaTransactionId) {
			throw new Error('Prava transaction id is unavailable.');
		}
		const mandate = await ctx.runQuery(internal.payments.getOwnedMandate, {
			mandateId: charge.mandateId,
			userId: args.userId
		});
		if (!mandate?.pravaMandateId) {
			throw new Error('Prava mandate id is unavailable.');
		}
		const reportBody: MandateReportRequest = {
			txn_status: args.outcome === 'approved' ? 'APPROVED' : 'DECLINED',
			txn_type: 'PURCHASE'
		};
		if (args.amountPaid !== undefined) reportBody.amount_paid = args.amountPaid;
		await pravaRequest(
			`/v1/mandates/${encodeURIComponent(mandate.pravaMandateId)}/charges/${encodeURIComponent(charge.pravaTransactionId)}/report`,
			{
				method: 'POST',
				body: JSON.stringify(reportBody)
			}
		);
		return null;
	}
});

export const completeRetriedChargeReport = internalMutation({
	args: onCompleteValidator,
	returns: v.null(),
	handler: async (ctx, args) => {
		const retrierRunId = args.runId;
		const charge = await ctx.db
			.query('mandateCharges')
			.withIndex('by_reportRetrierRunId', (query) => query.eq('reportRetrierRunId', retrierRunId))
			.unique();
		if (!charge) {
			return null;
		}
		if (args.result.type === 'success' && charge.reportOutcome) {
			await ctx.db.patch('mandateCharges', charge._id, {
				status: statusForOutcome(charge.reportOutcome),
				reportingStartedAt: undefined,
				reportOutcome: undefined,
				reportedAt: charge.reportedAt ?? Date.now(),
				updatedAt: Date.now()
			});
			return null;
		}
		if (!charge.reportedAt) {
			const reportPatch: ChargeReportReleasePatch = {
				reportingStartedAt: undefined,
				reportRetrierRunId: undefined,
				updatedAt: Date.now()
			};
			await ctx.db.patch('mandateCharges', charge._id, reportPatch);
		}
		return null;
	}
});

// ---------------------------------------------------------------------------
// Public actions (called by the executor's tools)
// ---------------------------------------------------------------------------

const mandateSetupArgs = {
	// Older agents still send this; current agents do not.
	userEmail: v.optional(v.string()),
	merchantName: v.optional(v.string()),
	merchantUrl: v.optional(v.string()),
	countryCode: v.optional(v.string()),
	amountCap: v.string(),
	currency: v.string(),
	frequency: vMandateFrequency,
	scope: vMandateScope,
	description: v.string(),
	maxCharges: v.optional(v.number()),
	validUntil: v.optional(v.string())
};

/** Create a Prava approval session plus the local pending mandate row. Shared
 * by the executor tool and the settings screen. */
async function createMandateSetup(
	ctx: ActionCtx,
	userId: string,
	args: ObjectType<typeof mandateSetupArgs>
): Promise<Infer<typeof vMandateSetupResult>> {
	if (args.userEmail !== undefined) {
		unsupportedClient();
	}
	// Executor actions carry no caller identity, so the Prava customer key is
	// the same stored userId the mandate rows keep (its legacy subject, when
	// this run was written before the tokenIdentifier migration) and the
	// email is what ensureCurrentUser synced onto the users row.
	const userEmail = await ctx.runQuery(internal.payments.getUserEmail, { userId });
	const pravaUserId =
		(await ctx.runQuery(internal.lib.auth.storedOwnerSubject, { userId })) ?? userId;
	assertMandateFrequencyAllowed(args);

	// Generic (any-scope) mandates are one-time only; Prava still needs a
	// purchase_context entry, so name a placeholder merchant for it.
	type MerchantDetails = { name: string; url: string; country_code_iso2: string };
	let merchantDetails: MerchantDetails;
	if (args.scope === 'listed') {
		if (!args.merchantName || !args.merchantUrl || !args.countryCode) {
			throw new Error('Listed-scope mandates require merchant name, URL, and country.');
		}
		merchantDetails = {
			name: args.merchantName,
			url: args.merchantUrl,
			country_code_iso2: args.countryCode
		};
	} else {
		merchantDetails = {
			name: 'Any merchant',
			url: 'https://prava.space',
			country_code_iso2: 'US'
		};
	}

	const response = await pravaRequest<{
		iframe_url: string;
		session_id: string;
		expires_at: string;
	}>('/v1/sessions', {
		method: 'POST',
		body: JSON.stringify({
			integration_type: 'embedding',
			user_id: pravaUserId,
			user_email: userEmail,
			total_amount: args.amountCap,
			currency: args.currency,
			description: args.description,
			purchase_context: {
				custom: [
					{
						merchant_details: merchantDetails,
						product_details: [
							{ description: args.description, unit_price: args.amountCap, quantity: 1 }
						]
					}
				]
			},
			mandate_setup: (() => {
				const setup: MandateSetupRequest = {
					intent: 'mandate_setup',
					recurring_frequency: args.frequency,
					merchant_scope: args.scope
				};
				if (args.maxCharges !== undefined) setup.max_charges = args.maxCharges;
				if (args.validUntil !== undefined) setup.valid_until = args.validUntil;
				return setup;
			})()
		})
	});

	const mandateId = await ctx.runMutation(internal.payments.insertMandate, {
		userId,
		pravaSessionId: response.session_id,
		merchantName: args.merchantName,
		merchantUrl: args.merchantUrl,
		countryCode: args.countryCode,
		amountCap: args.amountCap,
		currency: args.currency,
		frequency: args.frequency,
		scope: args.scope,
		description: args.description,
		approvalUrl: response.iframe_url
	});
	return {
		mandateId,
		approvalUrl: response.iframe_url,
		expiresAt: response.expires_at
	};
}

export const mandateSetup = action({
	args: {
		...mandateSetupArgs,
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: vMandateSetupResult,
	handler: async (ctx, args): Promise<Infer<typeof vMandateSetupResult>> => {
		try {
			const actor = await activeActor(ctx, args);
			return await createMandateSetup(ctx, actor.userId, args);
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

/** True when a live Prava mandate uniquely matches a local setup's merchant,
 * amount cap, and currency. Used both for charge-time resolution and for
 * linking local rows after the owner approves in a new tab. */
function isMatchingLivePravaMandate(mandate: Doc<'mandates'>, prava: PravaMandate): boolean {
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
async function resolvePravaMandate(
	ctx: ActionCtx,
	userId: string,
	mandate: Doc<'mandates'>
): Promise<PravaMandate & { id: string }> {
	// List under the original Prava customer key: pre-migration rows carry
	// the subject while the caller now hands us the tokenIdentifier.
	const pravaUserId =
		(await ctx.runQuery(internal.lib.auth.storedOwnerSubject, { userId })) ?? userId;
	if (mandate.pravaMandateId) {
		const found = await pravaRequest<PravaMandate>(
			`/v1/mandates/${encodeURIComponent(mandate.pravaMandateId)}`
		);
		return { ...found, id: mandate.pravaMandateId };
	}
	const list = await listPravaMandates(pravaUserId, false);
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
async function listLinkedMandates(
	ctx: ActionCtx,
	userId: string
): Promise<Infer<typeof vMandateListResult>> {
	const pravaUserId =
		(await ctx.runQuery(internal.lib.auth.storedOwnerSubject, { userId })) ?? userId;
	const list = (await listPravaMandates(pravaUserId, false)).filter((m) =>
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

export const mandateStatus = action({
	args: {
		mandateId: v.id('mandates'),
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: vMandateStatusResult,
	handler: async (ctx, args): Promise<Infer<typeof vMandateStatusResult>> => {
		try {
			const actor = await activeActor(ctx, args);
			const mandate = await ctx.runQuery(internal.payments.getOwnedMandate, {
				mandateId: args.mandateId,
				userId: actor.userId
			});
			if (!mandate) throw new Error('Mandate not found.');

			let synced = mandate;
			if (LIVE_MANDATE_STATUSES.has(mandate.status)) {
				try {
					const prava = await resolvePravaMandate(ctx, actor.userId, mandate);
					const sync = mandateSyncArgs(mandate._id, actor.userId, prava);
					await ctx.runMutation(internal.payments.syncMandate, sync);
					synced = withMandateSync(mandate, sync);
				} catch {
					// Still awaiting the owner's passkey approval, so keep the stored status.
				}
			}
			return mandateStatusResult(synced);
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

export const mandateList = action({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: vMandateListResult,
	handler: async (ctx, args): Promise<Infer<typeof vMandateListResult>> => {
		try {
			const actor = await activeActor(ctx, args);
			return await listLinkedMandates(ctx, actor.userId);
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

export const mandateCharge = action({
	args: {
		mandateId: v.id('mandates'),
		amount: v.string(),
		currency: v.string(),
		description: v.string(),
		reference: v.optional(v.string()),
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: vMandateChargeResult,
	handler: async (ctx, args): Promise<Infer<typeof vMandateChargeResult>> => {
		try {
			const actor = await activeActor(ctx, args);
			const mandate = await ctx.runQuery(internal.payments.getOwnedMandate, {
				mandateId: args.mandateId,
				userId: actor.userId
			});
			if (!mandate) throw new Error('Mandate not found.');
			assertChargeable(mandate, args);
			if (mandate.status === 'paused') {
				throw new Error('Mandate is paused and cannot be charged.');
			}

			const reference = args.reference?.trim() || undefined;
			const reservation = await ctx.runMutation(internal.payments.reserveCharge, {
				mandateId: mandate._id,
				runId: args.runId,
				userId: actor.userId,
				amount: args.amount,
				currency: mandate.currency,
				description: args.description,
				reference
			});
			if (reservation.kind === 'existing') {
				// Credentials are never persisted, only the non-sensitive handle.
				return {
					chargeId: reservation.chargeId,
					transactionId: reservation.transactionId
				};
			}
			if (reservation.kind === 'inFlight') {
				throw new Error('A charge with this reference is already in progress. Retry shortly.');
			}

			const prava = await resolvePravaMandate(ctx, actor.userId, mandate);
			if ((prava.status ?? '').toLowerCase() !== 'active') {
				await ctx.runMutation(internal.payments.releaseChargeReservation, {
					chargeId: reservation.chargeId,
					userId: actor.userId
				});
				throw new Error('Mandate is not active and cannot be charged.');
			}
			let result: {
				transactionId?: string;
				status?: string;
				errorCode?: string;
				credentials?: {
					token: string;
					dynamicCvv: string;
					expiryMonth: string;
					expiryYear: string;
				};
				errorMessage?: string;
			};
			// Mark before the network call so a lost response cannot be mistaken
			// for an abandoned reservation that is safe to reclaim.
			await ctx.runMutation(internal.payments.markChargeProviderRequested, {
				chargeId: reservation.chargeId,
				userId: actor.userId
			});
			try {
				result = await pravaRequest(`/v1/mandates/${encodeURIComponent(prava.id)}/charge`, {
					method: 'POST',
					body: JSON.stringify(
						(() => {
							const chargeBody: MandateChargeRequest = {
								amount: args.amount
							};
							if (reference !== undefined) chargeBody.reference = reference;
							return chargeBody;
						})()
					)
				});
			} catch (error) {
				await ctx.runMutation(internal.payments.releaseChargeReservation, {
					chargeId: reservation.chargeId,
					userId: actor.userId
				});
				throw error;
			}

			const { credentials, transactionId } = result;
			if (result.status === 'failed' || !credentials || !transactionId) {
				await ctx.runMutation(internal.payments.updateChargeStatus, {
					chargeId: reservation.chargeId,
					userId: actor.userId,
					status: 'failed'
				});
				throw new Error(result.errorMessage ?? result.errorCode ?? 'Mandate charge failed.');
			}
			await ctx.runMutation(internal.payments.completeCharge, {
				chargeId: reservation.chargeId,
				userId: actor.userId,
				pravaTransactionId: transactionId
			});
			// Return only validated credential fields. Prava may include extras
			// (e.g. dynamicDataType) that must not leak into the action result.
			return {
				chargeId: reservation.chargeId,
				transactionId,
				token: credentials.token,
				dynamicCvv: credentials.dynamicCvv,
				expiryMonth: credentials.expiryMonth,
				expiryYear: credentials.expiryYear
			};
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

export const mandateReport = action({
	args: {
		chargeId: v.id('mandateCharges'),
		outcome: vMandateReportOutcome,
		amountPaid: v.optional(v.string()),
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: vMandateReportResult,
	handler: async (ctx, args): Promise<Infer<typeof vMandateReportResult>> => {
		try {
			const actor = await activeActor(ctx, args);
			const charge = await ctx.runQuery(internal.payments.getOwnedCharge, {
				chargeId: args.chargeId,
				userId: actor.userId
			});
			if (!charge) throw new Error('Charge not found.');
			if (charge.reportedAt) {
				return { reported: true, alreadyReported: true };
			}
			if (charge.reportOutcome && charge.reportOutcome !== args.outcome) {
				throw new Error(
					`Charge already has a ${charge.reportOutcome} report in progress; the outcome cannot be changed.`
				);
			}

			if (charge.reportRetrierRunId) {
				// SAFETY: persisted ids are Action Retrier RunIds from reportRetrier.run().
				const status = await reportRetrier.status(ctx, charge.reportRetrierRunId as RunId);
				if (status.type === 'inProgress') {
					return { reported: false, inFlight: true };
				}
				if (status.type === 'completed' && status.result.type === 'success') {
					if (!charge.reportedAt && charge.reportOutcome) {
						await ctx.runMutation(internal.payments.finishChargeReport, {
							chargeId: charge._id,
							userId: actor.userId,
							status: statusForOutcome(charge.reportOutcome)
						});
					}
					return { reported: true, alreadyReported: true };
				}
			}

			const claim = await ctx.runMutation(internal.payments.claimChargeReport, {
				chargeId: charge._id,
				userId: actor.userId,
				outcome: args.outcome
			});
			if (claim === 'already') {
				return { reported: true, alreadyReported: true };
			}
			if (claim === 'inFlight') {
				return { reported: false, inFlight: true };
			}

			if (!charge.pravaTransactionId) {
				await ctx.runMutation(internal.payments.releaseChargeReport, {
					chargeId: charge._id,
					userId: actor.userId,
					clearOutcome: true
				});
				throw new Error('Prava transaction id is unavailable.');
			}
			const mandate = await ctx.runQuery(internal.payments.getOwnedMandate, {
				mandateId: charge.mandateId,
				userId: actor.userId
			});
			if (!mandate?.pravaMandateId) {
				await ctx.runMutation(internal.payments.releaseChargeReport, {
					chargeId: charge._id,
					userId: actor.userId,
					clearOutcome: true
				});
				throw new Error('Prava mandate id is unavailable.');
			}

			const startArgs: ChargeReportPostArgs = {
				chargeId: charge._id,
				userId: actor.userId,
				outcome: args.outcome
			};
			if (args.amountPaid !== undefined) startArgs.amountPaid = args.amountPaid;
			await ctx.runMutation(internal.payments.startChargeReportRetrier, startArgs);
			return { reported: false, inFlight: true };
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

// ---------------------------------------------------------------------------
// User-facing actions (settings screen; authenticated user, no agent run).
// These resolve the same owner key as the executor tools (the caller's stored
// userId), so mandate ownership checks are identical on both paths.
// ---------------------------------------------------------------------------

export const listMyMandates = action({
	args: {},
	returns: vMandateListResult,
	handler: async (ctx): Promise<Infer<typeof vMandateListResult>> => {
		return await listLinkedMandates(ctx, await getUserId(ctx));
	}
});

export const setupMyMandate = action({
	args: mandateSetupArgs,
	returns: vMandateSetupResult,
	handler: async (ctx, args): Promise<Infer<typeof vMandateSetupResult>> => {
		return await createMandateSetup(ctx, await getUserId(ctx), args);
	}
});

const vLifecycleAction = v.union(v.literal('pause'), v.literal('resume'), v.literal('cancel'));

export const setMyMandateLifecycle = action({
	args: {
		mandateId: v.id('mandates'),
		action: vLifecycleAction
	},
	returns: vMandateStatusResult,
	handler: async (ctx, args): Promise<Infer<typeof vMandateStatusResult>> => {
		const userId = await getUserId(ctx);
		const mandate = await ctx.runQuery(internal.payments.getOwnedMandate, {
			mandateId: args.mandateId,
			userId
		});
		if (!mandate) throw new Error('Mandate not found.');
		// Settings approve in a new tab, so the local row may still lack the
		// Prava mandate id until the first list/lifecycle call links it.
		const pravaMandateId =
			mandate.pravaMandateId ?? (await resolvePravaMandate(ctx, userId, mandate)).id;

		const updated = await pravaRequest<PravaMandate>(
			`/v1/mandates/${encodeURIComponent(pravaMandateId)}/${args.action}`,
			{ method: 'POST' }
		);
		const sync = mandateSyncArgs(mandate._id, userId, { ...updated, id: pravaMandateId });
		await ctx.runMutation(internal.payments.syncMandate, sync);
		return mandateStatusResult(withMandateSync(mandate, sync));
	}
});
