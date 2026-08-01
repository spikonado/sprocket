import { v, type Infer } from 'convex/values';
import { action, internalMutation, internalQuery, type ActionCtx } from '@convex/_generated/server';
import { api, internal } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import { isRunClaimLeaseActive } from '@convex/lib/runLease';
import {
	vCreatePurchaseSessionResult,
	vPaymentCredentialResult,
	vPurchaseStatusResult,
	vReportPurchaseStatusResult
} from '@convex/lib/validators';

const DEFAULT_PRAVA_BACKEND_URL = 'https://sandbox.api.prava.space';

type PaymentResult = {
	session_id: string;
	status: string;
	transactions: Array<{
		txn_id: string;
		status: string;
		line_items: Array<{
			txn_ref_id: string;
			merchant_name: string;
			merchant_url: string;
			total_amount: string;
			status: string;
			token: string | null;
			dynamic_cvv: string | null;
			expiry_month: string | null;
			expiry_year: string | null;
		}>;
		error?: { code: string; message: string };
	}>;
};

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

async function paymentResult(pravaSessionId: string): Promise<PaymentResult> {
	return await pravaRequest<PaymentResult>(
		`/v1/sessions/${encodeURIComponent(pravaSessionId)}/payment-result`
	);
}

function requiredUserEmail(userEmail: string): string {
	const email = userEmail.trim();
	if (!email) {
		throw new Error('User email is required.');
	}
	return email;
}

function credentialFrom(result: PaymentResult) {
	for (const transaction of result.transactions) {
		for (const item of transaction.line_items) {
			if (
				item.token &&
				item.dynamic_cvv &&
				item.expiry_month &&
				item.expiry_year &&
				item.txn_ref_id
			) {
				return {
					ready: true as const,
					token: item.token,
					dynamicCvv: item.dynamic_cvv,
					expiryMonth: item.expiry_month,
					expiryYear: item.expiry_year,
					txnRefId: item.txn_ref_id
				};
			}
		}
	}
	return undefined;
}

const purchaseDoc = v.object({
	_id: v.id('purchases'),
	_creationTime: v.number(),
	userId: v.string(),
	runId: v.id('runs'),
	pravaSessionId: v.string(),
	merchantName: v.string(),
	merchantUrl: v.string(),
	totalAmount: v.string(),
	currency: v.string(),
	description: v.string(),
	status: v.union(
		v.literal('awaiting_passkey'),
		v.literal('awaiting_result'),
		v.literal('spent'),
		v.literal('declined'),
		v.literal('failed'),
		v.literal('expired')
	),
	reportedAt: v.optional(v.number()),
	reportingStartedAt: v.optional(v.number()),
	reportOutcome: v.optional(v.union(v.literal('approved'), v.literal('declined'))),
	createdAt: v.number(),
	updatedAt: v.number()
});

export const insertPurchase = internalMutation({
	args: {
		userId: v.string(),
		runId: v.id('runs'),
		pravaSessionId: v.string(),
		merchantName: v.string(),
		merchantUrl: v.string(),
		totalAmount: v.string(),
		currency: v.string(),
		description: v.string()
	},
	returns: v.id('purchases'),
	handler: async (ctx, args) => {
		const now = Date.now();
		return await ctx.db.insert('purchases', {
			...args,
			status: 'awaiting_passkey',
			createdAt: now,
			updatedAt: now
		});
	}
});

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
export const getOwnedPurchase = internalQuery({
	args: { purchaseId: v.id('purchases'), userId: v.string() },
	returns: v.union(purchaseDoc, v.null()),
	handler: async (ctx, args) => {
		const purchase = await ctx.db.get(args.purchaseId);
		return purchase?.userId === args.userId ? purchase : null;
	}
});

export const updatePurchaseStatus = internalMutation({
	args: {
		purchaseId: v.id('purchases'),
		userId: v.string(),
		status: v.union(v.literal('awaiting_result'), v.literal('failed'), v.literal('expired'))
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const purchase = await ctx.db.get(args.purchaseId);
		if (!purchase || purchase.userId !== args.userId) {
			throw new Error('Purchase not found.');
		}
		// Never rewind a terminal or already-reported purchase.
		if (
			purchase.reportedAt ||
			purchase.status === 'spent' ||
			purchase.status === 'declined' ||
			purchase.status === 'failed' ||
			purchase.status === 'expired'
		) {
			return null;
		}
		await ctx.db.patch(args.purchaseId, { status: args.status, updatedAt: Date.now() });
		return null;
	}
});

/** Atomically claim the right to report to Prava.
 * - 'claimed': this caller may proceed to call Prava.
 * - 'already': a terminal report already happened (or a same-outcome report
 *   is actively in flight) — nothing to do.
 * - 'reconcile': a prior claim was left behind (e.g. the process died after
 *   Prava accepted but before the durable finish). This caller must re-run
 *   the stored outcome and finalize. */
export const claimPurchaseReport = internalMutation({
	args: {
		purchaseId: v.id('purchases'),
		userId: v.string(),
		outcome: v.union(v.literal('approved'), v.literal('declined'))
	},
	returns: v.union(v.literal('claimed'), v.literal('already')),
	handler: async (ctx, args) => {
		const purchase = await ctx.db.get(args.purchaseId);
		if (!purchase || purchase.userId !== args.userId) {
			throw new Error('Purchase not found.');
		}
		if (purchase.reportedAt) {
			return 'already';
		}
		if (purchase.reportingStartedAt) {
			// The action reconciles interrupted claims before calling this, so a
			// remaining in-flight claim belongs to a live concurrent caller.
			return 'already';
		}
		await ctx.db.patch(args.purchaseId, {
			reportingStartedAt: Date.now(),
			reportOutcome: args.outcome,
			updatedAt: Date.now()
		});
		return 'claimed';
	}
});

export const releasePurchaseReport = internalMutation({
	args: { purchaseId: v.id('purchases'), userId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const purchase = await ctx.db.get(args.purchaseId);
		if (!purchase || purchase.userId !== args.userId) {
			throw new Error('Purchase not found.');
		}
		if (!purchase.reportedAt) {
			await ctx.db.patch(args.purchaseId, {
				reportingStartedAt: undefined,
				reportOutcome: undefined,
				updatedAt: Date.now()
			});
		}
		return null;
	}
});

export const finishPurchaseReport = internalMutation({
	args: {
		purchaseId: v.id('purchases'),
		userId: v.string(),
		status: v.union(v.literal('spent'), v.literal('declined'))
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const purchase = await ctx.db.get(args.purchaseId);
		if (!purchase || purchase.userId !== args.userId) {
			throw new Error('Purchase not found.');
		}
		if (!purchase.reportedAt) {
			const now = Date.now();
			await ctx.db.patch(args.purchaseId, {
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

export const createPurchaseSession = action({
	args: {
		userEmail: v.optional(v.string()),
		merchantName: v.string(),
		merchantUrl: v.string(),
		countryCode: v.string(),
		totalAmount: v.string(),
		currency: v.string(),
		description: v.string(),
		items: v.optional(
			v.array(
				v.object({
					description: v.string(),
					unitPrice: v.string(),
					quantity: v.optional(v.number())
				})
			)
		),
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: vCreatePurchaseSessionResult,
	handler: async (ctx, args): Promise<Infer<typeof vCreatePurchaseSessionResult>> => {
		const actor = await activeActor(ctx, args);
		const storedEmail: string | null = await ctx.runQuery(internal.payments.getPaymentsEmail, {
			userId: actor.userId
		});
		const userEmail = requiredUserEmail(args.userEmail ?? storedEmail ?? '');
		const productDetails =
			args.items && args.items.length > 0
				? args.items.map((item) => ({
						description: item.description,
						unit_price: item.unitPrice,
						quantity: item.quantity ?? 1
					}))
				: [{ description: args.description, unit_price: args.totalAmount, quantity: 1 }];
		const response = await pravaRequest<{
			session_id: string;
			session_token: string;
			expires_at: string;
			iframe_url: string;
			order_id: string;
		}>('/v1/sessions', {
			method: 'POST',
			body: JSON.stringify({
				user_id: actor.userId,
				user_email: userEmail,
				total_amount: args.totalAmount,
				currency: args.currency,
				description: args.description,
				purchase_context: [
					{
						merchant_details: {
							name: args.merchantName,
							url: args.merchantUrl,
							country_code_iso2: args.countryCode
						},
						product_details: productDetails,
						effective_until_minutes: 15
					}
				]
			})
		});
		const purchaseId: string = await ctx.runMutation(internal.payments.insertPurchase, {
			userId: actor.userId,
			runId: args.runId,
			pravaSessionId: response.session_id,
			merchantName: args.merchantName,
			merchantUrl: args.merchantUrl,
			totalAmount: args.totalAmount,
			currency: args.currency,
			description: args.description
		});
		return {
			purchaseId,
			iframeUrl: response.iframe_url,
			expiresAt: response.expires_at
		};
	}
});

export const getPaymentCredential = action({
	args: {
		purchaseId: v.id('purchases'),
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: vPaymentCredentialResult,
	handler: async (ctx, args): Promise<Infer<typeof vPaymentCredentialResult>> => {
		const actor = await activeActor(ctx, args);
		const purchase = await ctx.runQuery(internal.payments.getOwnedPurchase, {
			purchaseId: args.purchaseId,
			userId: actor.userId
		});
		if (!purchase) throw new Error('Purchase not found.');

		const result = await paymentResult(purchase.pravaSessionId);
		const credential = credentialFrom(result);
		if (credential) {
			await ctx.runMutation(internal.payments.updatePurchaseStatus, {
				purchaseId: purchase._id,
				userId: actor.userId,
				status: 'awaiting_result'
			});
			return credential;
		}
		if (
			result.status === 'awaiting_result' ||
			result.status === 'failed' ||
			result.status === 'expired'
		) {
			await ctx.runMutation(internal.payments.updatePurchaseStatus, {
				purchaseId: purchase._id,
				userId: actor.userId,
				status: result.status
			});
		}
		return { ready: false, status: result.status };
	}
});

export const reportStatus = action({
	args: {
		purchaseId: v.id('purchases'),
		outcome: v.union(v.literal('approved'), v.literal('declined')),
		txnRefId: v.optional(v.string()),
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: vReportPurchaseStatusResult,
	handler: async (ctx, args): Promise<Infer<typeof vReportPurchaseStatusResult>> => {
		const actor = await activeActor(ctx, args);
		const purchase = await ctx.runQuery(internal.payments.getOwnedPurchase, {
			purchaseId: args.purchaseId,
			userId: actor.userId
		});
		if (!purchase) throw new Error('Purchase not found.');
		if (purchase.reportedAt) {
			return { reported: true, alreadyReported: true };
		}

		// A claim older than the report window belongs to a crashed caller
		// (Prava may have accepted but the durable finish never ran). Reconcile
		// it to the stored outcome's terminal state instead of falsely returning
		// success. A fresh in-flight claim is left for its live caller.
		const REPORT_CLAIM_STALE_MS = 60_000;
		const claimIsStale =
			purchase.reportingStartedAt !== undefined &&
			Date.now() - purchase.reportingStartedAt > REPORT_CLAIM_STALE_MS;
		if (claimIsStale && purchase.reportOutcome) {
			await ctx.runMutation(internal.payments.finishPurchaseReport, {
				purchaseId: purchase._id,
				userId: actor.userId,
				status: purchase.reportOutcome === 'approved' ? 'spent' : 'declined'
			});
			return { reported: true, alreadyReported: true };
		}

		const claim = await ctx.runMutation(internal.payments.claimPurchaseReport, {
			purchaseId: purchase._id,
			userId: actor.userId,
			outcome: args.outcome
		});
		if (claim === 'already') {
			return { reported: true, alreadyReported: true };
		}

		let txnRefId = args.txnRefId?.trim();
		if (!txnRefId) {
			const result = await paymentResult(purchase.pravaSessionId);
			txnRefId = result.transactions
				.flatMap((transaction) => transaction.line_items)
				.find((item) => item.txn_ref_id)?.txn_ref_id;
		}
		if (!txnRefId) {
			await ctx.runMutation(internal.payments.releasePurchaseReport, {
				purchaseId: purchase._id,
				userId: actor.userId
			});
			throw new Error('Prava transaction reference is unavailable.');
		}
		try {
			await pravaRequest(
				`/v1/sessions/${encodeURIComponent(purchase.pravaSessionId)}/report-status`,
				{
					method: 'POST',
					body: JSON.stringify({
						txn_ref_id: txnRefId,
						txn_status: args.outcome === 'approved' ? 'APPROVED' : 'DECLINED'
					})
				}
			);
		} catch (error) {
			await ctx.runMutation(internal.payments.releasePurchaseReport, {
				purchaseId: purchase._id,
				userId: actor.userId
			});
			throw error;
		}
		await ctx.runMutation(internal.payments.finishPurchaseReport, {
			purchaseId: purchase._id,
			userId: actor.userId,
			status: args.outcome === 'approved' ? 'spent' : 'declined'
		});
		return { reported: true };
	}
});

export const getPurchaseStatus = action({
	args: {
		purchaseId: v.id('purchases'),
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: vPurchaseStatusResult,
	handler: async (ctx, args): Promise<Infer<typeof vPurchaseStatusResult>> => {
		const actor = await activeActor(ctx, args);
		const purchase = await ctx.runQuery(internal.payments.getOwnedPurchase, {
			purchaseId: args.purchaseId,
			userId: actor.userId
		});
		if (!purchase) throw new Error('Purchase not found.');
		return {
			status: purchase.status,
			merchantName: purchase.merchantName,
			merchantUrl: purchase.merchantUrl,
			totalAmount: purchase.totalAmount,
			currency: purchase.currency,
			description: purchase.description
		};
	}
});
