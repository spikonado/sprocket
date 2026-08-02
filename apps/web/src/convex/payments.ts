import { v, type Infer } from 'convex/values';
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
	pravaSessionId: v.optional(v.string()),
	merchantName: v.optional(v.string()),
	merchantUrl: v.optional(v.string()),
	countryCode: v.optional(v.string()),
	amountCap: v.string(),
	currency: v.string(),
	frequency: vMandateFrequency,
	scope: vMandateScope,
	status: vMandateStatus,
	approvalUrl: v.optional(v.string()),
	validUntil: v.optional(v.string()),
	renewsAt: v.optional(v.string()),
	remaining: v.optional(v.string()),
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
	amount: v.string(),
	currency: v.string(),
	description: v.string(),
	reference: v.optional(v.string()),
	status: vMandateChargeStatus,
	reportOutcome: v.optional(vMandateReportOutcome),
	reportedAt: v.optional(v.number()),
	reportingStartedAt: v.optional(v.number()),
	createdAt: v.number(),
	updatedAt: v.number()
});

type PravaMandate = {
	id?: string;
	status?: string;
	remaining?: string;
	approvedAmount?: string;
	currency?: string;
	merchantName?: string | null;
	validUntil?: string | null;
	renewsAt?: string | null;
};

function pravaStatusToLocal(status: string | undefined): Infer<typeof vMandateStatus> | undefined {
	return isMandateStatus(status) ? status : undefined;
}

/** Parse a decimal money string to minor units as a bigint. Fixed-point, so
 * "0.1" + "0.2" class errors can't leak into cap comparisons. */
function parseMoneyMinor(value: string): bigint | undefined {
	const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
	if (!match) return undefined;
	const units = BigInt(match[1]);
	const fraction = (match[2] ?? '').padEnd(2, '0');
	return units * 100n + BigInt(fraction || '0');
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
	if (amount === undefined || amount <= 0n) {
		throw new Error('Charge amount must be a positive decimal string.');
	}
	const cap = parseMoneyMinor(mandate.amountCap);
	if (cap !== undefined && amount > cap) {
		throw new Error(`Charge amount exceeds the mandate's ${mandate.amountCap} cap.`);
	}
	const remaining = mandate.remaining ? parseMoneyMinor(mandate.remaining) : undefined;
	if (remaining !== undefined && amount > remaining) {
		throw new Error(`Charge amount exceeds the mandate's remaining ${mandate.remaining}.`);
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
		remaining: mandate.remaining ?? undefined,
		validUntil: mandate.validUntil ?? undefined,
		renewsAt: mandate.renewsAt ?? undefined
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
		approvalUrl: v.string()
	},
	returns: v.id('mandates'),
	handler: async (ctx, args) => {
		const now = Date.now();
		return await ctx.db.insert('mandates', {
			...args,
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
		remaining: v.optional(v.string()),
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

export const insertCharge = internalMutation({
	args: {
		mandateId: v.id('mandates'),
		runId: v.id('runs'),
		userId: v.string(),
		pravaTransactionId: v.optional(v.string()),
		amount: v.string(),
		currency: v.string(),
		description: v.string(),
		reference: v.optional(v.string())
	},
	returns: v.id('mandateCharges'),
	handler: async (ctx, args) => {
		const now = Date.now();
		return await ctx.db.insert('mandateCharges', {
			...args,
			status: 'awaiting_result',
			createdAt: now,
			updatedAt: now
		});
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
			await ctx.db.patch(args.chargeId, { status: args.status, updatedAt: Date.now() });
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
	args: { chargeId: v.id('mandateCharges'), userId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const charge = await ownedCharge(ctx, args.chargeId, args.userId);
		if (!charge.reportedAt) {
			await ctx.db.patch(args.chargeId, {
				reportingStartedAt: undefined,
				reportOutcome: undefined,
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

export const mandateSetup = action({
	args: {
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
		validUntil: v.optional(v.string()),
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: vMandateSetupResult,
	handler: async (ctx, args): Promise<Infer<typeof vMandateSetupResult>> => {
		const actor = await activeActor(ctx, args);
		const storedEmail: string | null = await ctx.runQuery(internal.payments.getPaymentsEmail, {
			userId: actor.userId
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
			session_token: string;
			expires_at: string;
		}>('/v1/sessions', {
			method: 'POST',
			body: JSON.stringify({
				integration_type: 'embedding',
				user_id: actor.userId,
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
			userId: actor.userId,
			pravaSessionId: response.session_id,
			merchantName: args.merchantName,
			merchantUrl: args.merchantUrl,
			countryCode: args.countryCode,
			amountCap: args.amountCap,
			currency: args.currency,
			frequency: args.frequency,
			scope: args.scope,
			approvalUrl: response.iframe_url
		});
		return {
			mandateId,
			approvalUrl: response.iframe_url,
			sessionToken: response.session_token,
			expiresAt: response.expires_at
		};
	}
});

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
	const matches = list.filter((m) => {
		if (!m.id) return false;
		if (!LIVE_MANDATE_STATUSES.has(m.status ?? '')) return false;
		// A mandate approved in another currency is a different authorization —
		// never resolve (and later charge) it for this setup.
		if ((m.currency ?? '').toUpperCase() !== mandate.currency.toUpperCase()) return false;
		if (mandate.scope === 'listed') {
			return (
				(m.merchantName ?? '').toLowerCase() === (mandate.merchantName ?? '').toLowerCase() &&
				m.approvedAmount === mandate.amountCap
			);
		}
		return m.approvedAmount === mandate.amountCap;
	});
	// Require a unique live match — charging an arbitrary same-merchant+amount
	// approval could settle against the wrong authorization. Prava mandates
	// don't carry their setup session id, so there is no stronger link to
	// prefer on.
	if (matches.length === 0) {
		throw new Error('Mandate is not yet approved.');
	}
	if (matches.length > 1) {
		throw new Error(
			'Multiple approved mandates match this setup; resolve the ambiguity before charging.'
		);
	}
	const resolved = { ...matches[0], id: matches[0].id! };
	await ctx.runMutation(
		internal.payments.syncMandate,
		mandateSyncArgs(mandate._id, userId, resolved)
	);
	return resolved;
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

		let status = mandate.status;
		let remaining = mandate.remaining;
		let pravaMandateId = mandate.pravaMandateId;
		let validUntil = mandate.validUntil;
		let renewsAt = mandate.renewsAt;
		if (status === 'pending' || status === 'active' || status === 'paused') {
			try {
				const prava = await resolvePravaMandate(ctx, actor.userId, mandate);
				pravaMandateId = prava.id;
				const local = pravaStatusToLocal(prava.status);
				if (local) status = local;
				if (prava.remaining !== undefined) remaining = prava.remaining;
				if (prava.validUntil != null) validUntil = prava.validUntil;
				if (prava.renewsAt != null) renewsAt = prava.renewsAt;
				await ctx.runMutation(
					internal.payments.syncMandate,
					mandateSyncArgs(mandate._id, actor.userId, prava)
				);
			} catch {
				// Still awaiting the owner's passkey approval — keep the stored status.
			}
		}
		return {
			mandateId: mandate._id,
			pravaMandateId,
			status,
			merchantName: mandate.merchantName,
			amountCap: mandate.amountCap,
			remaining,
			currency: mandate.currency,
			frequency: mandate.frequency,
			scope: mandate.scope,
			approvalUrl: mandate.approvalUrl,
			validUntil,
			renewsAt
		};
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
		const list = (await listPravaMandates(actor.userId, false)).filter((m) =>
			LIVE_MANDATE_STATUSES.has(m.status ?? '')
		);
		const local = await ctx.runQuery(internal.payments.listLocalMandates, {
			userId: actor.userId
		});
		const localByPravaId = new Map(
			local.filter((m) => m.pravaMandateId).map((m) => [m.pravaMandateId as string, m._id])
		);
		return {
			mandates: list.map((m) => ({
				mandateId: m.id ? localByPravaId.get(m.id) : undefined,
				pravaMandateId: m.id ?? '',
				status: m.status ?? 'unknown',
				merchantName: m.merchantName ?? undefined,
				approvedAmount: m.approvedAmount ?? '',
				remaining: m.remaining,
				currency: m.currency ?? '',
				validUntil: m.validUntil ?? undefined,
				renewsAt: m.renewsAt ?? undefined
			}))
		};
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

		const prava = await resolvePravaMandate(ctx, actor.userId, mandate);
		const result = await pravaRequest<{
			transactionId?: string;
			status?: string;
			credentials?: {
				token: string;
				dynamicCvv: string;
				expiryMonth: string;
				expiryYear: string;
			};
			errorMessage?: string;
		}>(`/v1/mandates/${encodeURIComponent(prava.id)}/charge`, {
			method: 'POST',
			body: JSON.stringify({
				amount: args.amount,
				...(args.reference !== undefined ? { reference: args.reference } : {})
			})
		});

		const { credentials, transactionId } = result;
		const chargeId = await ctx.runMutation(internal.payments.insertCharge, {
			mandateId: mandate._id,
			runId: args.runId,
			userId: actor.userId,
			pravaTransactionId: transactionId,
			amount: args.amount,
			currency: mandate.currency,
			description: args.description,
			reference: args.reference
		});
		if (result.status === 'failed' || !credentials || !transactionId) {
			await ctx.runMutation(internal.payments.updateChargeStatus, {
				chargeId,
				userId: actor.userId,
				status: 'failed'
			});
			throw new Error(result.errorMessage ?? 'Mandate charge failed.');
		}
		return {
			chargeId,
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
				userId: actor.userId
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
				userId: actor.userId
			});
			throw new Error('Prava mandate id is unavailable.');
		}
		// The outcome being reported is the one bound at claim time, not
		// whatever this caller passed — a stale retry can't switch it.
		const outcome = charge.reportOutcome ?? args.outcome;
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
		const userId = await getUserId(ctx);
		const list = (await listPravaMandates(userId, false)).filter((m) =>
			LIVE_MANDATE_STATUSES.has(m.status ?? '')
		);
		// Join Prava's live mandates with the local rows (keyed on the
		// Prava mandate id) so each entry carries the local mandateId the
		// lifecycle action needs. Entries without a local row (e.g. approved
		// elsewhere) are still listed, just without a mandateId.
		const local = await ctx.runQuery(internal.payments.listLocalMandates, { userId });
		const localByPravaId = new Map(
			local.filter((m) => m.pravaMandateId).map((m) => [m.pravaMandateId as string, m._id])
		);
		return {
			mandates: list.map((m) => ({
				mandateId: m.id ? localByPravaId.get(m.id) : undefined,
				pravaMandateId: m.id ?? '',
				status: m.status ?? 'unknown',
				merchantName: m.merchantName ?? undefined,
				approvedAmount: m.approvedAmount ?? '',
				remaining: m.remaining,
				currency: m.currency ?? '',
				validUntil: m.validUntil ?? undefined,
				renewsAt: m.renewsAt ?? undefined
			}))
		};
	}
});

export const setupMyMandate = action({
	args: {
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
	},
	returns: vMandateSetupResult,
	handler: async (ctx, args): Promise<Infer<typeof vMandateSetupResult>> => {
		const userId = await getUserId(ctx);
		const storedEmail: string | null = await ctx.runQuery(internal.payments.getPaymentsEmail, {
			userId
		});
		const userEmail = requiredUserEmail(args.userEmail ?? storedEmail ?? '');
		assertMandateFrequencyAllowed(args);

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
			session_token: string;
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
			approvalUrl: response.iframe_url
		});
		return {
			mandateId,
			approvalUrl: response.iframe_url,
			sessionToken: response.session_token,
			expiresAt: response.expires_at
		};
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
		if (!mandate.pravaMandateId) {
			throw new Error('Mandate is not yet approved.');
		}

		const updated = await pravaRequest<PravaMandate>(
			`/v1/mandates/${encodeURIComponent(mandate.pravaMandateId)}/${args.action}`,
			{ method: 'POST' }
		);
		const status = pravaStatusToLocal(updated.status);
		await ctx.runMutation(internal.payments.syncMandate, {
			mandateId: mandate._id,
			userId,
			status,
			remaining: updated.remaining ?? undefined,
			validUntil: updated.validUntil ?? undefined,
			renewsAt: updated.renewsAt ?? undefined
		});
		return {
			mandateId: mandate._id,
			pravaMandateId: mandate.pravaMandateId,
			status: status ?? mandate.status,
			merchantName: mandate.merchantName,
			amountCap: mandate.amountCap,
			remaining: updated.remaining ?? mandate.remaining,
			currency: mandate.currency,
			frequency: mandate.frequency,
			scope: mandate.scope,
			approvalUrl: mandate.approvalUrl,
			validUntil: updated.validUntil ?? mandate.validUntil,
			renewsAt: updated.renewsAt ?? mandate.renewsAt
		};
	}
});
