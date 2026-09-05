import { ActionRetrier, onCompleteValidator, type RunId } from '@convex-dev/action-retrier';
import { v, type Infer, type ObjectType } from 'convex/values';
import {
	action,
	internalAction,
	internalMutation,
	internalQuery,
	type ActionCtx
} from '@convex/_generated/server';
import { components, internal } from '@convex/_generated/api';
import { getUserId, pickPrimaryUser } from '@convex/lib/auth';
import { toAgentToolConvexError } from '@convex/lib/agentErrors';
import { unsupportedClient } from '@convex/lib/unsupportedClient';
import {
	vMandateReportOutcome,
	vMandateFrequency,
	vMandateScope,
	vMandateStatus,
	vMandateSetupResult,
	vMandateStatusResult,
	vMandateListResult,
	vMandateChargeResult,
	vMandateReportResult
} from '@convex/lib/validators';
import { requireMoneyMinor } from '@convex/lib/payments/money';
import { pravaRequest, type PravaMandate } from '@convex/lib/payments/prava';
import {
	activeActor,
	assertMandateFrequencyAllowed,
	LIVE_MANDATE_STATUSES,
	listLinkedMandates,
	mandateDoc,
	mandateStatusResult,
	mandateSyncArgs,
	resolvePravaMandate,
	withMandateSync
} from '@convex/lib/payments/mandates';
import {
	assertChargeable,
	CHARGE_CLAIM_STALE_MS,
	chargeDoc,
	type ChargeReportPostArgs,
	type ChargeReportReleasePatch,
	type ChargeStatusPatch,
	type MandateChargeRequest,
	type MandateReportRequest,
	ownedCharge,
	REPORT_CLAIM_STALE_MS,
	statusForOutcome
} from '@convex/lib/payments/charges';

const reportRetrier = new ActionRetrier(components.actionRetrier, {
	initialBackoffMs: 250,
	base: 2,
	maxFailures: 4
});

type MandateSyncPatch = {
	updatedAt: number;
	pravaMandateId?: string;
	status?: Infer<typeof vMandateStatus>;
	remaining?: number;
	validUntil?: string;
	renewsAt?: string;
};

type MandateSetupRequest = {
	intent: 'mandate_setup';
	recurring_frequency: Infer<typeof vMandateFrequency>;
	merchant_scope: Infer<typeof vMandateScope>;
	max_charges?: number;
	valid_until?: string;
};

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
		return mandate?.userId === args.userId ? mandate : null;
	}
});

/** The user's WorkOS email, synced onto their users row by
 * ensureCurrentUser. Executor actions carry no usable caller identity (the
 * run's auth token is a launch-time snapshot), so capability-gated code reads
 * it from here instead of ctx.auth. */
export const getUserEmail = internalQuery({
	args: { userId: v.string() },
	returns: v.string(),
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query('users')
			.withIndex('by_subject', (query) => query.eq('subject', args.userId))
			.collect();
		const primary = pickPrimaryUser(rows);
		if (!primary) throw new Error(`No user record for ${args.userId}.`);
		return primary.email;
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
		try {
			const mandate = await ctx.db.get('mandates', args.mandateId);
			if (!mandate || mandate.userId !== args.userId) {
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
					if (existing.userId !== args.userId) {
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
	// Prava requires a customer email on merchant sessions. Executor actions
	// carry no caller identity, so read the WorkOS email that ensureCurrentUser
	// keeps on the users row instead of ctx.auth.
	const userEmail = await ctx.runQuery(internal.payments.getUserEmail, { userId });
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
			user_id: userId,
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
