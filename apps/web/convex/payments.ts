import { v, type Infer } from 'convex/values';
import {
	action,
	internalAction,
	internalMutation,
	internalQuery,
	query,
	type ActionCtx
} from '@convex/_generated/server';
import { internal } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { getExecutionRun, getUserId } from '@convex/lib/auth';
import { vCompletionActor } from '@convex/lib/docs';
import { isRunClaimLeaseActive } from '@convex/lib/runLease';
import { toAgentToolConvexError } from '@convex/lib/agentErrors';
import { vPurchaseStatus, type PurchaseStatus } from '@convex/lib/validators';
import {
	AgentcardError,
	agentcardCredentials,
	agentcardRequest,
	exchangeAgentcardToken,
	isCheckoutOrigin,
	recognizes,
	type AgentcardAuthorization,
	type VaultSession,
	type Recognizer
} from '@convex/lib/payments/agentcard';

/** Agentcard answers `connection_not_found` for a user it doesn't know in this
 * mode, which means the same as an empty vault. */
function isUnknownAgentcardUser<Caught>(error: Caught) {
	return error instanceof AgentcardError && error.code === 'connection_not_found';
}

const runAuth = { runId: v.id('runs'), claimId: v.string(), executionSecret: v.string() };

const vPurchase = v.object({
	_id: v.id('purchases'),
	threadId: v.id('threadRecords'),
	merchant: v.string(),
	amount: v.number(),
	currency: v.string(),
	status: vPurchaseStatus,
	approvalUrl: v.string(),
	orderNumber: v.optional(v.string()),
	createdAt: v.number()
});

function purchaseView(purchase: Doc<'purchases'>): Infer<typeof vPurchase> {
	return {
		_id: purchase._id,
		threadId: purchase.threadId,
		merchant: purchase.merchant,
		amount: purchase.amount,
		currency: purchase.currency,
		status: purchase.status,
		approvalUrl: purchase.approvalUrl,
		orderNumber: purchase.orderNumber,
		createdAt: purchase._creationTime
	};
}

/** Statuses only move forward: a late or replayed update never reopens an
 * approval or undoes a settlement. */
function nextPurchaseStatus(current: PurchaseStatus, incoming: PurchaseStatus): PurchaseStatus {
	if (current === 'settled' || incoming === 'awaiting_approval') return current;

	return incoming;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

export const paymentActor = internalQuery({
	// Cancelling often happens because the run just ended, so it skips the lease check.
	args: { ...runAuth, allowEndedRun: v.optional(v.boolean()) },
	returns: vCompletionActor,
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
		const leaseActive = args.allowEndedRun || isRunClaimLeaseActive(run, Date.now());

		if (run.claimId !== args.claimId || !leaseActive) {
			throw new Error('Run is no longer active.');
		}

		const thread = await ctx.db.get('threadRecords', run.threadId);

		if (!thread) throw new Error('Thread not found.');

		if (thread.parentThreadId) throw new Error('Payment tools are unavailable to subagents.');

		return {
			userId: run.userId,
			threadId: run.threadId,
			status: run.status,
			claimId: run.claimId,
			claimExpiresAt: run.claimExpiresAt
		};
	}
});

export const cachedToken = internalQuery({
	args: { clientId: v.string() },
	returns: v.union(v.object({ accessToken: v.string(), expiresAt: v.number() }), v.null()),
	handler: async (ctx, args) => {
		const token = await ctx.db.query('agentcardTokens').first();

		return token?.clientId === args.clientId
			? { accessToken: token.accessToken, expiresAt: token.expiresAt }
			: null;
	}
});

export const saveToken = internalMutation({
	args: { clientId: v.string(), accessToken: v.string(), expiresAt: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		for (const token of await ctx.db.query('agentcardTokens').collect()) {
			await ctx.db.delete('agentcardTokens', token._id);
		}

		await ctx.db.insert('agentcardTokens', args);

		return null;
	}
});

export const agentcardUserId = internalQuery({
	args: { userId: v.string() },
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query('agentcardUsers')
			.withIndex('by_userId', (query) => query.eq('userId', args.userId))
			.unique();

		return row?.agentcardUserId ?? null;
	}
});

export const insertPurchase = internalMutation({
	args: {
		userId: v.string(),
		threadId: v.id('threadRecords'),
		attemptId: v.string(),
		authorizationId: v.string(),
		merchant: v.string(),
		amount: v.number(),
		currency: v.string(),
		approvalUrl: v.string()
	},
	returns: v.id('purchases'),
	handler: async (ctx, args) =>
		await ctx.db.insert('purchases', { ...args, status: 'awaiting_approval' })
});

export const attemptPurchaseId = internalQuery({
	args: { userId: v.string(), attemptId: v.string() },
	returns: v.union(v.id('purchases'), v.null()),
	handler: async (ctx, args) => {
		const purchase = await ctx.db
			.query('purchases')
			.withIndex('by_attemptId', (query) => query.eq('attemptId', args.attemptId))
			.unique();

		return purchase?.userId === args.userId ? purchase._id : null;
	}
});

export const ownedPurchase = internalQuery({
	args: { purchaseId: v.string(), userId: v.string() },
	returns: v.union(v.object({ authorizationId: v.string() }), v.null()),
	handler: async (ctx, args) => {
		const purchaseId = ctx.db.normalizeId('purchases', args.purchaseId);
		const purchase = purchaseId ? await ctx.db.get('purchases', purchaseId) : null;

		return purchase?.userId === args.userId ? { authorizationId: purchase.authorizationId } : null;
	}
});

export const updatePurchase = internalMutation({
	args: {
		authorizationId: v.string(),
		status: v.optional(vPurchaseStatus),
		orderNumber: v.optional(v.string())
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const purchase = await ctx.db
			.query('purchases')
			.withIndex('by_authorizationId', (query) => query.eq('authorizationId', args.authorizationId))
			.unique();

		if (!purchase) return null;

		const status = args.status ? nextPurchaseStatus(purchase.status, args.status) : purchase.status;

		if (status !== purchase.status || args.orderNumber !== undefined) {
			const patch: Partial<Doc<'purchases'>> = { status };

			if (args.orderNumber !== undefined) patch.orderNumber = args.orderNumber;

			await ctx.db.patch('purchases', purchase._id, patch);
		}

		return null;
	}
});

export const saveAgentcardUser = internalMutation({
	args: { userId: v.string(), agentcardUserId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('agentcardUsers')
			.withIndex('by_userId', (query) => query.eq('userId', args.userId))
			.unique();

		if (!existing) {
			await ctx.db.insert('agentcardUsers', args);
		} else if (existing.agentcardUserId !== args.agentcardUserId) {
			await ctx.db.patch('agentcardUsers', existing._id, { agentcardUserId: args.agentcardUserId });
		}

		return null;
	}
});

/** Reads the linked session instead of trusting the webhook body: the session
 * is the documented source of `external_user_id`, which is the Sprocket user. */
export const linkVaultSession = internalAction({
	args: { vaultSessionId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const session = await agentcardRequest<VaultSession>(
			await agentcardToken(ctx),
			`/api/v2/vault_sessions/${encodeURIComponent(args.vaultSessionId)}`
		);

		if (session.status === 'linked' && session.user_id && session.external_user_id) {
			await ctx.runMutation(internal.payments.saveAgentcardUser, {
				userId: session.external_user_id,
				agentcardUserId: session.user_id
			});
		}

		return null;
	}
});

/** One-off cleanup of retired Prava rows. Run once per deployment with
 * `bunx convex run payments:deleteRetiredMandates`. */
export const deleteRetiredMandates = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const mandates = await ctx.db.query('mandates').take(100);
		const charges = await ctx.db.query('mandateCharges').take(100);

		for (const row of mandates) await ctx.db.delete('mandates', row._id);

		for (const row of charges) await ctx.db.delete('mandateCharges', row._id);

		if (mandates.length === 100 || charges.length === 100) {
			await ctx.scheduler.runAfter(0, internal.payments.deleteRetiredMandates, {});
		}

		return null;
	}
});

// ---------------------------------------------------------------------------
// Agentcard access
// ---------------------------------------------------------------------------

async function agentcardToken(ctx: ActionCtx): Promise<string> {
	const credentials = agentcardCredentials();

	const cached = await ctx.runQuery(internal.payments.cachedToken, {
		clientId: credentials.clientId
	});

	if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.accessToken;

	const token = await exchangeAgentcardToken(credentials);
	await ctx.runMutation(internal.payments.saveToken, {
		clientId: credentials.clientId,
		...token
	});

	return token.accessToken;
}

async function listRecognizers(token: string): Promise<Recognizer[]> {
	const entries = await agentcardRequest<Recognizer[]>(
		token,
		'/api/v2/checkout/recognizers?modes=token'
	);

	return entries.map(({ psp, hosts, match }) => ({ psp, hosts, match }));
}

async function withAgentToolErrors<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
	}
}

async function activeActor(
	ctx: ActionCtx,
	args: { runId: Id<'runs'>; claimId: string; executionSecret: string },
	allowEndedRun = false
): Promise<Infer<typeof vCompletionActor>> {
	return await ctx.runQuery(internal.payments.paymentActor, {
		runId: args.runId,
		claimId: args.claimId,
		executionSecret: args.executionSecret,
		allowEndedRun
	});
}

async function ownedAuthorizationId(
	ctx: ActionCtx,
	purchaseId: string,
	userId: string
): Promise<string> {
	const purchase = await ctx.runQuery(internal.payments.ownedPurchase, { purchaseId, userId });

	if (!purchase) throw new Error('Purchase not found.');

	return purchase.authorizationId;
}

// ---------------------------------------------------------------------------
// Agent tools (card_checkout and report_order)
// ---------------------------------------------------------------------------

export const checkoutRecognizers = action({
	args: runAuth,
	returns: v.object({
		recognizers: v.array(
			v.object({ psp: v.string(), hosts: v.array(v.string()), match: v.string() })
		)
	}),
	handler: async (ctx, args) =>
		await withAgentToolErrors(async () => {
			await activeActor(ctx, args);

			return { recognizers: await listRecognizers(await agentcardToken(ctx)) };
		})
});

const vCheckoutCreateResult = v.union(
	v.object({ status: v.literal('card_required') }),
	v.object({
		status: v.literal('awaiting_approval'),
		purchaseId: v.id('purchases'),
		pollIntervalMs: v.number()
	})
);

export const checkoutCreate = action({
	args: {
		...runAuth,
		attemptId: v.string(),
		checkoutOrigin: v.string(),
		amount: v.string(),
		currency: v.string(),
		psp: v.string(),
		request: v.object({
			url: v.string(),
			method: v.string(),
			headers: v.record(v.string(), v.string()),
			body: v.optional(v.string())
		})
	},
	returns: vCheckoutCreateResult,
	handler: async (ctx, args): Promise<Infer<typeof vCheckoutCreateResult>> =>
		await withAgentToolErrors(async () => {
			const actor = await activeActor(ctx, args);

			const existingPurchaseId = await ctx.runQuery(internal.payments.attemptPurchaseId, {
				userId: actor.userId,
				attemptId: args.attemptId
			});

			if (existingPurchaseId) {
				return {
					status: 'awaiting_approval' as const,
					purchaseId: existingPurchaseId,
					pollIntervalMs: 2000
				};
			}

			if (!isCheckoutOrigin(args.checkoutOrigin)) {
				throw new Error('The checkout page must be an https origin.');
			}

			const amount = args.amount.trim();
			const currency = args.currency.trim().toLowerCase();

			if (!/^\d+(\.\d+)?$/.test(amount)) {
				throw new Error('Amount must be a decimal string such as "23.06".');
			}

			const token = await agentcardToken(ctx);
			const requestUrl = new URL(args.request.url);

			const recognized = (await listRecognizers(token)).some(
				(recognizer) => recognizer.psp === args.psp && recognizes(recognizer, requestUrl)
			);

			if (!recognized) throw new Error('That request is not a recognized payment request.');

			const user: string | null = await ctx.runQuery(internal.payments.agentcardUserId, {
				userId: actor.userId
			});

			if (!user) return { status: 'card_required' as const };

			const merchant = new URL(args.checkoutOrigin).hostname;
			let authorization: AgentcardAuthorization;

			try {
				authorization = await agentcardRequest<AgentcardAuthorization>(
					token,
					'/api/v2/checkout/authorizations',
					{
						method: 'POST',
						body: {
							user,
							merchant,
							checkout_origin: args.checkoutOrigin,
							amount,
							currency,
							psp: args.psp,
							request: args.request
						}
					}
				);
			} catch (error) {
				if (
					(error instanceof AgentcardError && error.code === 'card_not_found') ||
					isUnknownAgentcardUser(error)
				) {
					return { status: 'card_required' as const };
				}

				throw error;
			}

			if (!authorization.approvalUrl) {
				throw new Error('Agentcard returned no approval link for this purchase.');
			}

			const purchaseId: Id<'purchases'> = await ctx.runMutation(internal.payments.insertPurchase, {
				userId: actor.userId,
				threadId: actor.threadId,
				attemptId: args.attemptId,
				authorizationId: authorization.id,
				merchant,
				amount: authorization.amount ?? 0,
				currency: authorization.currency ?? currency,
				approvalUrl: authorization.approvalUrl
			});

			return {
				status: 'awaiting_approval' as const,
				purchaseId,
				pollIntervalMs: authorization.poll_interval_ms ?? 2000
			};
		})
});

const vCheckoutPollResult = v.object({
	status: v.union(
		v.literal('awaiting_approval'),
		v.literal('approved'),
		v.literal('submitted_on_device'),
		v.literal('declined'),
		v.literal('expired')
	),
	pollIntervalMs: v.number(),
	reason: v.optional(v.string()),
	response: v.optional(
		v.object({
			status: v.number(),
			headers: v.record(v.string(), v.string()),
			body: v.string()
		})
	)
});

export const checkoutPoll = action({
	args: { ...runAuth, purchaseId: v.string() },
	returns: vCheckoutPollResult,
	handler: async (ctx, args) =>
		await withAgentToolErrors(async () => {
			const actor = await activeActor(ctx, args);
			const authorizationId = await ownedAuthorizationId(ctx, args.purchaseId, actor.userId);
			let authorization: AgentcardAuthorization;

			try {
				authorization = await agentcardRequest<AgentcardAuthorization>(
					await agentcardToken(ctx),
					`/api/v2/checkout/authorizations/${encodeURIComponent(authorizationId)}`
				);
			} catch (error) {
				if (error instanceof AgentcardError && error.code === 'slow_down') {
					return { status: 'awaiting_approval' as const, pollIntervalMs: 2000 };
				}

				throw error;
			}

			await ctx.runMutation(internal.payments.updatePurchase, {
				authorizationId,
				status: authorization.settlement?.status === 'settled' ? 'settled' : authorization.status
			});

			const result: Infer<typeof vCheckoutPollResult> = {
				status: authorization.status,
				pollIntervalMs: authorization.poll_interval_ms ?? 2000
			};

			if (authorization.reason) result.reason = authorization.reason;

			if (authorization.status === 'approved' && authorization.response) {
				result.response = authorization.response;
			}

			return result;
		})
});

export const checkoutCancel = action({
	args: { ...runAuth, purchaseId: v.string() },
	returns: v.object({ status: v.string() }),
	handler: async (ctx, args) =>
		await withAgentToolErrors(async () => {
			const actor = await activeActor(ctx, args, true);
			const authorizationId = await ownedAuthorizationId(ctx, args.purchaseId, actor.userId);

			try {
				await agentcardRequest(
					await agentcardToken(ctx),
					`/api/v2/checkout/authorizations/${encodeURIComponent(authorizationId)}/cancel`,
					{ method: 'POST', body: {} }
				);
			} catch (error) {
				if (error instanceof AgentcardError && error.code === 'outcome_unknown') {
					return { status: 'outcome_unknown' };
				}

				throw error;
			}

			await ctx.runMutation(internal.payments.updatePurchase, {
				authorizationId,
				status: 'declined'
			});

			return { status: 'declined' };
		})
});

export const reportOrder = action({
	args: { ...runAuth, purchaseId: v.string(), orderNumber: v.string() },
	returns: v.object({ purchaseId: v.string() }),
	handler: async (ctx, args) =>
		await withAgentToolErrors(async () => {
			const actor = await activeActor(ctx, args);
			const orderNumber = args.orderNumber.trim();

			if (!orderNumber) throw new Error('Order number is required.');

			await ctx.runMutation(internal.payments.updatePurchase, {
				authorizationId: await ownedAuthorizationId(ctx, args.purchaseId, actor.userId),
				orderNumber
			});

			return { purchaseId: args.purchaseId };
		})
});

// ---------------------------------------------------------------------------
// Settings and thread UI (signed-in user)
// ---------------------------------------------------------------------------

const vSavedCards = v.object({
	cards: v.array(
		v.object({
			id: v.string(),
			brand: v.string(),
			last4: v.string(),
			expiryMonth: v.number(),
			expiryYear: v.number()
		})
	)
});

export const myPayments = action({
	args: {},
	returns: vSavedCards,
	handler: async (ctx): Promise<Infer<typeof vSavedCards>> => {
		const user: string | null = await ctx.runQuery(internal.payments.agentcardUserId, {
			userId: await getUserId(ctx)
		});

		if (!user) return { cards: [] };

		let cards: {
			data: {
				id: string;
				brand: string;
				last4: string;
				expiry_month: number;
				expiry_year: number;
			}[];
		};

		try {
			cards = await agentcardRequest(
				await agentcardToken(ctx),
				`/api/v2/vault_cards?user_id=${encodeURIComponent(user)}`
			);
		} catch (error) {
			if (isUnknownAgentcardUser(error)) return { cards: [] };

			throw error;
		}

		return {
			cards: cards.data.map((card) => ({
				id: card.id,
				brand: card.brand,
				last4: card.last4,
				expiryMonth: card.expiry_month,
				expiryYear: card.expiry_year
			}))
		};
	}
});

export const createCardLink = action({
	args: {},
	returns: v.object({ url: v.string() }),
	handler: async (ctx): Promise<{ url: string }> => {
		const userId = await getUserId(ctx);

		const linked: string | null = await ctx.runQuery(internal.payments.agentcardUserId, {
			userId
		});

		const session = await agentcardRequest<{ url: string }>(
			await agentcardToken(ctx),
			'/api/v2/vault_sessions',
			{
				method: 'POST',
				// A linked user only needs to add a card, not repeat sign-up.
				body: linked
					? { external_user_id: userId, approval_mode: 'customer', steps: ['card'] }
					: { external_user_id: userId, approval_mode: 'customer' }
			}
		);

		return { url: session.url };
	}
});

export const listMyPurchases = query({
	args: {},
	returns: v.array(vPurchase),
	handler: async (ctx) => {
		const userId = await getUserId(ctx);

		const purchases = await ctx.db
			.query('purchases')
			.withIndex('by_userId', (query) => query.eq('userId', userId))
			.order('desc')
			.take(100);

		return purchases.map(purchaseView);
	}
});

export const pendingThreadApprovals = query({
	args: { threadId: v.id('threadRecords') },
	returns: v.array(vPurchase),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const thread = await ctx.db.get('threadRecords', args.threadId);

		if (thread?.userId !== userId) return [];

		const purchases = await ctx.db
			.query('purchases')
			.withIndex('by_threadId_status', (query) =>
				query.eq('threadId', args.threadId).eq('status', 'awaiting_approval')
			)
			.take(20);

		return purchases.map(purchaseView);
	}
});
