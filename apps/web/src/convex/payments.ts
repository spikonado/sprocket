import { v, type Infer, type ObjectType } from 'convex/values';
import {
	action,
	internalMutation,
	internalQuery,
	type ActionCtx,
	type MutationCtx
} from '@convex/_generated/server';
import { api, internal } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { getUserId } from '@convex/lib/auth';
import { isRunClaimLeaseActive } from '@convex/lib/runLease';
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

const DEFAULT_PRAVA_BACKEND_URL = 'https://sandbox.api.prava.space';
const REPORT_CLAIM_STALE_MS = 60_000;
const CHARGE_CLAIM_STALE_MS = 60_000;

function pravaConfig(): { baseUrl: string; secretKey: string } {
	const secretKey = process.env.PRAVA_SECRET_KEY?.trim();
	if (!secretKey) {
		throw new Error('PRAVA_SECRET_KEY is not configured.');
	}
	return {
		baseUrl: (process.env.PRAVA_BACKEND_URL?.trim() || DEFAULT_PRAVA_BACKEND_URL).replace(
			/\/+$/,
			''
		),
		secretKey
	};
}

async function pravaRequest<T>(path: string, init?: RequestInit): Promise<T> {
	const { baseUrl, secretKey } = pravaConfig();
	const response = await fetch(`${baseUrl}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${secretKey}`,
			...(init?.body ? { 'Content-Type': 'application/json' } : {}),
			...init?.headers
		}
	});
	if (!response.ok) {
		const details = await response.text();
		throw new Error(`Prava request failed (${response.status})${details ? `: ${details}` : '.'}`);
	}
	const body = await response.text();
	return (body ? JSON.parse(body) : undefined) as T;
}

/** A first-time customer has no Prava customer record yet, so listing their
 * mandates 404s with CUSTOMER_NOT_FOUND — treat that as "no mandates yet"
 * rather than an error. */
function isPravaCustomerNotFound(error: unknown): boolean {
	return error instanceof Error && error.message.includes('CUSTOMER_NOT_FOUND');
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
		if (isPravaCustomerNotFound(error)) {
			return [];
		}
		throw error;
	}
}

/** Only these mandate states can be charged or should be surfaced to the
 * agent/user. Cancelled/expired/consumed approvals must not match a local
 * setup during resolution — a stale same-merchant+amount approval otherwise
 * poisons the unique-match check forever. */
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

function requiredUserEmail(userEmail: string): string {
	const email = userEmail.trim();
	if (!email) {
		throw new Error('EMAIL_REQUIRED');
	}
	return email;
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
	createdAt: v.number(),
	updatedAt: v.number()
});

type PravaMandate = {
	id?: string;
	status?: string;
	remaining?: string | null;
	approvedAmount?: string;
	currency?: string;
	merchantName?: string | null;
	merchantUrl?: string | null;
	merchant_url?: string | null;
	countryCode?: string | null;
	country_code_iso2?: string | null;
	validUntil?: string | null;
	renewsAt?: string | null;
};

function normalizeMerchantUrl(url: string): string {
	return url.trim().toLowerCase().replace(/\/+$/, '');
}

function normalizeCountryCode(code: string): string {
	return code.trim().toUpperCase();
}

function pravaMerchantUrl(mandate: PravaMandate): string | undefined {
	const url = mandate.merchantUrl ?? mandate.merchant_url;
	return url?.trim() ? url : undefined;
}

function pravaCountryCode(mandate: PravaMandate): string | undefined {
	const code = mandate.countryCode ?? mandate.country_code_iso2;
	return code?.trim() ? code : undefined;
}

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
 * still the authoritative limit enforcer at the card network — these checks
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
	const charge = await ctx.db.get(chargeId);
	if (!charge || charge.userId !== userId) {
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

export const getPaymentsEmail = internalQuery({
	args: { userId: v.string() },
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, args) => {
		const prefs = await ctx.db
			.query('uiPreferences')
			.withIndex('by_userId', (query) => query.eq('userId', args.userId))
			.unique();
		return prefs?.paymentsEmail ?? null;
	}
});

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
	}
});

export const getOwnedMandate = internalQuery({
	args: { mandateId: v.id('mandates'), userId: v.string() },
	returns: v.union(mandateDoc, v.null()),
	handler: async (ctx, args) => {
		const mandate = await ctx.db.get(args.mandateId);
		return mandate?.userId === args.userId ? mandate : null;
	}
});

export const listLocalMandates = internalQuery({
	args: { userId: v.string() },
	returns: v.array(mandateDoc),
	handler: async (ctx, args) => {
		return await ctx.db
			.query('mandates')
			.withIndex('by_user', (query) => query.eq('userId', args.userId))
			.collect();
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
		const mandate = await ctx.db.get(args.mandateId);
		if (!mandate || mandate.userId !== args.userId) {
			throw new Error('Mandate not found.');
		}
		const patch: Record<string, unknown> = { updatedAt: Date.now() };
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
		await ctx.db.patch(args.mandateId, patch);
		return null;
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
				if (existing.userId !== args.userId) {
					throw new Error('Charge not found.');
				}
				if (existing.amount !== amount || existing.currency !== args.currency) {
					throw new Error('Charge reference was already used with a different amount or currency.');
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
					// Never reclaim for another charge — that would double-bill.
					throw new Error(
						'A previous charge attempt for this reference may have already been submitted to Prava; refusing to charge again.'
					);
				}
				if (existing.status === 'failed') {
					await ctx.db.patch(existing._id, {
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
				await ctx.db.patch(existing._id, {
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
	}
});

export const markChargeProviderRequested = internalMutation({
	args: { chargeId: v.id('mandateCharges'), userId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		await ownedCharge(ctx, args.chargeId, args.userId);
		await ctx.db.patch(args.chargeId, {
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
		await ctx.db.patch(args.chargeId, {
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
			// providerRequestedAt — an ambiguous POST must not be reclaimed.
			await ctx.db.patch(args.chargeId, {
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
		const charge = await ctx.db.get(args.chargeId);
		return charge?.userId === args.userId ? charge : null;
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
			await ctx.db.patch(args.chargeId, {
				status: args.status,
				chargingStartedAt: undefined,
				// Definitive provider failure (or local fail) — allow a later
				// same-reference retry to reclaim the row.
				...(args.status === 'failed' ? { providerRequestedAt: undefined } : {}),
				updatedAt: Date.now()
			});
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
		const charge = await ownedCharge(ctx, args.chargeId, args.userId);
		if (charge.reportedAt) {
			return 'already';
		}
		// The first-claimed outcome is immutable. A conflicting report must
		// never be sent — a crash between the provider POST and the local
		// finalize would otherwise let a retry overwrite the outcome and POST
		// the opposite terminal state to the card network.
		if (charge.reportOutcome && charge.reportOutcome !== args.outcome) {
			throw new Error(
				`Charge already has a ${charge.reportOutcome} report in progress; the outcome cannot be changed.`
			);
		}
		if (charge.reportingStartedAt) {
			// A claim newer than the report window belongs to a live concurrent
			// caller and has not completed — say so rather than claim success. An
			// older one is abandoned (its caller died), so reclaim it and re-send;
			// the provider report is idempotent on the transaction id.
			if (Date.now() - charge.reportingStartedAt <= REPORT_CLAIM_STALE_MS) {
				return 'inFlight';
			}
		}
		await ctx.db.patch(args.chargeId, {
			reportingStartedAt: Date.now(),
			reportOutcome: args.outcome,
			updatedAt: Date.now()
		});
		return 'claimed';
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
			await ctx.db.patch(args.chargeId, {
				reportingStartedAt: undefined,
				...(args.clearOutcome ? { reportOutcome: undefined } : {}),
				updatedAt: Date.now()
			});
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
			await ctx.db.patch(args.chargeId, {
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

// ---------------------------------------------------------------------------
// Public actions (called by the executor's tools)
// ---------------------------------------------------------------------------

const mandateSetupArgs = {
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
	const storedEmail: string | null = await ctx.runQuery(internal.payments.getPaymentsEmail, {
		userId
	});
	const userEmail = requiredUserEmail(args.userEmail ?? storedEmail ?? '');
	assertMandateFrequencyAllowed(args);

	// Generic (any-scope) mandates are one-time only; Prava still needs a
	// purchase_context entry, so name a placeholder merchant for it.
	let merchantDetails: { name: string; url: string; country_code_iso2: string };
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
			user_id: userId,
			user_email: userEmail,
			total_amount: args.amountCap,
			currency: args.currency,
			description: args.description,
			purchase_context: [
				{
					merchant_details: merchantDetails,
					product_details: [
						{ description: args.description, unit_price: args.amountCap, quantity: 1 }
					]
				}
			],
			mandate_setup: {
				intent: 'mandate_setup',
				recurring_frequency: args.frequency,
				merchant_scope: args.scope,
				...(args.maxCharges !== undefined ? { max_charges: args.maxCharges } : {}),
				...(args.validUntil !== undefined ? { valid_until: args.validUntil } : {})
			}
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
		const actor = await activeActor(ctx, args);
		return await createMandateSetup(ctx, actor.userId, args);
	}
});

/** True when a live Prava mandate uniquely matches a local setup's merchant,
 * amount cap, and currency. Used both for charge-time resolution and for
 * linking local rows after the owner approves in a new tab. */
function isMatchingLivePravaMandate(mandate: Doc<'mandates'>, prava: PravaMandate): boolean {
	if (!prava.id) return false;
	if (!LIVE_MANDATE_STATUSES.has(prava.status ?? '')) return false;
	// A mandate approved in another currency is a different authorization —
	// never resolve (and later charge) it for this setup.
	if ((prava.currency ?? '').toUpperCase() !== mandate.currency.toUpperCase()) return false;
	const approvedMinor = prava.approvedAmount ? parseMoneyMinor(prava.approvedAmount) : undefined;
	if (approvedMinor === undefined || approvedMinor !== mandate.amountCap) return false;
	if (mandate.scope === 'listed') {
		const localName = mandate.merchantName?.trim();
		const localUrl = mandate.merchantUrl?.trim();
		const localCountry = mandate.countryCode?.trim();
		const remoteUrl = pravaMerchantUrl(prava);
		const remoteCountry = pravaCountryCode(prava);
		if (!localName || !localUrl || !localCountry || !remoteUrl || !remoteCountry) {
			return false;
		}
		return (
			(prava.merchantName ?? '').toLowerCase() === localName.toLowerCase() &&
			normalizeMerchantUrl(remoteUrl) === normalizeMerchantUrl(localUrl) &&
			normalizeCountryCode(remoteCountry) === normalizeCountryCode(localCountry)
		);
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
			.map((row) => row.pravaMandateId as string)
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
	if (mandate.pravaMandateId) {
		const found = await pravaRequest<PravaMandate>(
			`/v1/mandates/${encodeURIComponent(mandate.pravaMandateId)}`
		);
		return { ...found, id: mandate.pravaMandateId };
	}
	const list = await listPravaMandates(userId, false);
	const local = await ctx.runQuery(internal.payments.listLocalMandates, { userId });
	const match = uniquelyAttributablePravaMandate(mandate, list, local);
	// Require a unique live match — charging an arbitrary same-merchant+amount
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
 * the live list and persist the link — otherwise settings can't pause/cancel. */
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
		local.filter((m) => m.pravaMandateId).map((m) => [m.pravaMandateId as string, m._id])
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

export const mandateStatus = action({
	args: {
		mandateId: v.id('mandates'),
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: vMandateStatusResult,
	handler: async (ctx, args): Promise<Infer<typeof vMandateStatusResult>> => {
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
				// Still awaiting the owner's passkey approval — keep the stored status.
			}
		}
		return mandateStatusResult(synced);
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
		const actor = await activeActor(ctx, args);
		return await listLinkedMandates(ctx, actor.userId);
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
			// Credentials are never persisted — only the non-sensitive handle.
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
				body: JSON.stringify({
					amount: args.amount,
					...(reference !== undefined ? { reference } : {})
				})
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
			throw new Error(result.errorMessage ?? 'Mandate charge failed.');
		}
		await ctx.runMutation(internal.payments.completeCharge, {
			chargeId: reservation.chargeId,
			userId: actor.userId,
			pravaTransactionId: transactionId
		});
		// Return credentials only for this response — do not persist them.
		return {
			chargeId: reservation.chargeId,
			transactionId,
			...credentials
		};
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
		const actor = await activeActor(ctx, args);
		const charge = await ctx.runQuery(internal.payments.getOwnedCharge, {
			chargeId: args.chargeId,
			userId: actor.userId
		});
		if (!charge) throw new Error('Charge not found.');
		if (charge.reportedAt) {
			return { reported: true, alreadyReported: true };
		}

		// claimChargeReport atomically reserves this report (reclaiming an
		// abandoned stale claim), so only one caller reaches Prava per attempt.
		const claim = await ctx.runMutation(internal.payments.claimChargeReport, {
			chargeId: charge._id,
			userId: actor.userId,
			outcome: args.outcome
		});
		if (claim === 'already') {
			return { reported: true, alreadyReported: true };
		}
		if (claim === 'inFlight') {
			// Another caller is mid-report. Not yet delivered — don't claim success.
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
		// claimChargeReport rejects a conflicting outcome, so args.outcome is
		// the bound terminal state for this charge.
		const outcome = args.outcome;
		try {
			await pravaRequest(
				`/v1/mandates/${encodeURIComponent(mandate.pravaMandateId)}/charges/${encodeURIComponent(charge.pravaTransactionId)}/report`,
				{
					method: 'POST',
					body: JSON.stringify({
						txn_status: outcome === 'approved' ? 'APPROVED' : 'DECLINED',
						txn_type: 'PURCHASE',
						...(args.amountPaid !== undefined ? { amount_paid: args.amountPaid } : {})
					})
				}
			);
		} catch (error) {
			// Ambiguous delivery: the POST may have committed remotely. Drop the
			// in-flight claim so a same-outcome retry can re-send (idempotent on
			// transaction id), but keep reportOutcome so the opposite result
			// cannot be reserved later.
			await ctx.runMutation(internal.payments.releaseChargeReport, {
				chargeId: charge._id,
				userId: actor.userId
			});
			throw error;
		}
		await ctx.runMutation(internal.payments.finishChargeReport, {
			chargeId: charge._id,
			userId: actor.userId,
			status: statusForOutcome(outcome)
		});
		return { reported: true };
	}
});

// ---------------------------------------------------------------------------
// User-facing actions (settings screen — authenticated user, no agent run).
// These resolve the same identity.subject as the executor tools, so mandate
// ownership checks are identical on both paths.
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
