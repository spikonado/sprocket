import { v, type Infer } from 'convex/values';
import { action, internalMutation, internalQuery, type ActionCtx } from '@convex/_generated/server';
import { api, internal } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import { isRunClaimLeaseActive } from '@convex/lib/runLease';
import {
	vMandateSetupResult,
	vMandateStatusResult,
	vMandateListResult,
	vMandateChargeResult,
	vMandateReportResult
} from '@convex/lib/validators';

const DEFAULT_PRAVA_BACKEND_URL = 'https://sandbox.api.prava.space';

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
		throw new Error('User email is required.');
	}
	return email;
}

const vMandateFrequency = v.union(
	v.literal('one_time'),
	v.literal('weekly'),
	v.literal('monthly'),
	v.literal('yearly')
);
const vMandateScope = v.union(v.literal('listed'), v.literal('any'));
const vMandateStatus = v.union(
	v.literal('pending'),
	v.literal('active'),
	v.literal('paused'),
	v.literal('consumed'),
	v.literal('cancelled'),
	v.literal('expired')
);

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
	status: v.union(
		v.literal('awaiting_result'),
		v.literal('completed'),
		v.literal('declined'),
		v.literal('failed')
	),
	reportOutcome: v.optional(v.union(v.literal('approved'), v.literal('declined'))),
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
	switch (status) {
		case 'pending':
		case 'active':
		case 'paused':
		case 'consumed':
		case 'cancelled':
		case 'expired':
			return status;
		default:
			return undefined;
	}
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

export const listUserMandates = internalQuery({
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
		const charge = await ctx.db.get(args.chargeId);
		if (!charge || charge.userId !== args.userId) {
			throw new Error('Charge not found.');
		}
		if (!charge.reportedAt) {
			await ctx.db.patch(args.chargeId, { status: args.status, updatedAt: Date.now() });
		}
		return null;
	}
});

/** Atomically claim the right to report a charge to Prava. 'claimed' lets this
 * caller proceed; 'already' means a terminal report happened (or a live
 * same-outcome claim is in flight). */
export const claimChargeReport = internalMutation({
	args: {
		chargeId: v.id('mandateCharges'),
		userId: v.string(),
		outcome: v.union(v.literal('approved'), v.literal('declined'))
	},
	returns: v.union(v.literal('claimed'), v.literal('already')),
	handler: async (ctx, args) => {
		const charge = await ctx.db.get(args.chargeId);
		if (!charge || charge.userId !== args.userId) {
			throw new Error('Charge not found.');
		}
		if (charge.reportedAt || charge.reportingStartedAt) {
			return 'already';
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
		const charge = await ctx.db.get(args.chargeId);
		if (!charge || charge.userId !== args.userId) {
			throw new Error('Charge not found.');
		}
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
		const charge = await ctx.db.get(args.chargeId);
		if (!charge || charge.userId !== args.userId) {
			throw new Error('Charge not found.');
		}
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

		const isListed = args.scope === 'listed';
		if (isListed && (!args.merchantName || !args.merchantUrl || !args.countryCode)) {
			throw new Error('Listed-scope mandates require merchant name, URL, and country.');
		}
		// Generic (any-scope) mandates are one-time only; Prava still needs a
		// purchase_context entry, so name a placeholder merchant for it.
		const merchantDetails =
			isListed && args.merchantName && args.merchantUrl && args.countryCode
				? {
						name: args.merchantName,
						url: args.merchantUrl,
						country_code_iso2: args.countryCode
					}
				: { name: 'Any merchant', url: 'https://prava.space', country_code_iso2: 'US' };

		const response = await pravaRequest<{
			session_id: string;
			iframe_url: string;
			expires_at: string;
			authorizeOnly?: boolean;
		}>('/v1/sessions', {
			method: 'POST',
			body: JSON.stringify({
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
		return { mandateId, approvalUrl: response.iframe_url, expiresAt: response.expires_at };
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
	const list = await pravaRequest<{ mandates?: PravaMandate[] }>(
		`/v1/mandates?customer_id=${encodeURIComponent(userId)}`
	);
	const found = (list.mandates ?? []).find((m) => {
		if (!m.id) return false;
		if (mandate.scope === 'listed') {
			return (
				(m.merchantName ?? '').toLowerCase() === (mandate.merchantName ?? '').toLowerCase() &&
				m.approvedAmount === mandate.amountCap
			);
		}
		return m.approvedAmount === mandate.amountCap;
	});
	if (!found?.id) {
		throw new Error('Mandate is not yet approved.');
	}
	await ctx.runMutation(internal.payments.syncMandate, {
		mandateId: mandate._id,
		userId,
		pravaMandateId: found.id,
		status: pravaStatusToLocal(found.status),
		remaining: found.remaining ?? undefined,
		validUntil: found.validUntil ?? undefined,
		renewsAt: found.renewsAt ?? undefined
	});
	return { ...found, id: found.id };
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
				await ctx.runMutation(internal.payments.syncMandate, {
					mandateId: mandate._id,
					userId: actor.userId,
					pravaMandateId: prava.id,
					status: local,
					remaining: prava.remaining ?? undefined,
					validUntil: prava.validUntil ?? undefined,
					renewsAt: prava.renewsAt ?? undefined
				});
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
		const list = await pravaRequest<{ mandates?: PravaMandate[] }>(
			`/v1/mandates?customer_id=${encodeURIComponent(actor.userId)}&standing_only=true`
		);
		return {
			mandates: (list.mandates ?? []).map((m) => ({
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

		const failed = result.status === 'failed' || !result.credentials || !result.transactionId;
		const chargeId = await ctx.runMutation(internal.payments.insertCharge, {
			mandateId: mandate._id,
			runId: args.runId,
			userId: actor.userId,
			pravaTransactionId: result.transactionId,
			amount: args.amount,
			currency: args.currency,
			description: args.description,
			reference: args.reference
		});
		if (failed) {
			await ctx.runMutation(internal.payments.updateChargeStatus, {
				chargeId,
				userId: actor.userId,
				status: 'failed'
			});
			throw new Error(result.errorMessage ?? 'Mandate charge failed.');
		}
		return {
			chargeId,
			transactionId: result.transactionId!,
			token: result.credentials!.token,
			dynamicCvv: result.credentials!.dynamicCvv,
			expiryMonth: result.credentials!.expiryMonth,
			expiryYear: result.credentials!.expiryYear
		};
	}
});

export const mandateReport = action({
	args: {
		chargeId: v.id('mandateCharges'),
		outcome: v.union(v.literal('approved'), v.literal('declined')),
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

		// A claim older than the report window belongs to a crashed caller;
		// reconcile it to the stored outcome's terminal state on retry.
		const REPORT_CLAIM_STALE_MS = 60_000;
		const claimIsStale =
			charge.reportingStartedAt !== undefined &&
			Date.now() - charge.reportingStartedAt > REPORT_CLAIM_STALE_MS;
		if (claimIsStale && charge.reportOutcome) {
			await ctx.runMutation(internal.payments.finishChargeReport, {
				chargeId: charge._id,
				userId: actor.userId,
				status: charge.reportOutcome === 'approved' ? 'completed' : 'declined'
			});
			return { reported: true, alreadyReported: true };
		}

		const claim = await ctx.runMutation(internal.payments.claimChargeReport, {
			chargeId: charge._id,
			userId: actor.userId,
			outcome: args.outcome
		});
		if (claim === 'already') {
			return { reported: true, alreadyReported: true };
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
		try {
			await pravaRequest(
				`/v1/mandates/${encodeURIComponent(mandate.pravaMandateId)}/charges/${encodeURIComponent(charge.pravaTransactionId)}/report`,
				{
					method: 'POST',
					body: JSON.stringify({
						txn_status: args.outcome === 'approved' ? 'APPROVED' : 'DECLINED',
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
			status: args.outcome === 'approved' ? 'completed' : 'declined'
		});
		return { reported: true };
	}
});
