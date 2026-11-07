import { ConvexError, v } from 'convex/values';
import { api, internal } from '@convex/_generated/api';
import {
	action,
	env,
	internalMutation,
	internalQuery,
	mutation,
	query
} from '@convex/_generated/server';
import type { MutationCtx, QueryCtx } from '@convex/_generated/server';
import type { Doc } from '@convex/_generated/dataModel';
import { ensureCurrentUser, getUserBySubject, getUserId, requireIdentity } from '@convex/lib/auth';
import { resolveMarketingPricingUrls } from '@convex/lib/marketingOrigin';
import { resolvePlan } from '@convex/lib/tiers';
import {
	vBillingInterval,
	vCheckoutAttemptStatus,
	vDodoMode,
	vSubscriptionTier
} from '@convex/lib/validators';
import { readDodoEnvironment } from '@convex/lib/dodoProducts';

const CHECKOUT_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

const MAX_OPEN_CHECKOUT_SELECTIONS = 25;

const CHECKOUT_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

const CHECKOUT_CLEANUP_PAGE_SIZE = 100;

function checkoutOutcomeIsTerminal(outcome: string | undefined): boolean {
	return outcome === 'paid' || outcome === 'failed';
}

const AMBIGUOUS_CREATE_RETRY_MS = 30 * 1_000;

const CHECKOUT_PROVIDER_REQUEST_BUDGET = 8;

export const LIVE_SUBSCRIPTION_CHECKOUT_ERROR =
	'You already have a subscription. Use "Manage billing" to change it.';

// Public checkout mode; never the raw provider environment name.
type DodoMode = 'test' | 'live';

function publicMode(mode: 'test_mode' | 'live_mode'): DodoMode {
	return mode === 'live_mode' ? 'live' : 'test';
}

function billingApiKey(): string {
	const key = env.DODO_PAYMENTS_API_KEY?.trim();

	if (!key) throw new Error('Payments are not configured.');

	return key;
}

function assertCheckoutConfigured(): void {
	if (!env.DODO_PAYMENTS_WEBHOOK_SECRET?.trim()) {
		throw new Error('Payments are not configured.');
	}

	readDodoEnvironment(env);
	billingApiKey();
	resolveMarketingPricingUrls(env, 'readiness-probe');
}

function assertPaymentsConfigured(): void {
	readDodoEnvironment(env);
	billingApiKey();
}

export const getMySubscription = query({
	args: {},
	returns: v.object({
		tier: vSubscriptionTier,
		tierLabel: v.string(),
		billingManaged: v.boolean(),
		accessPhase: v.optional(
			v.union(
				v.literal('active'),
				v.literal('scheduled_cancel'),
				v.literal('ended'),
				v.literal('none')
			)
		)
	}),
	handler: async (ctx) => {
		const userId = await getUserId(ctx);
		const plan = await resolvePlan(ctx, userId, Date.now());
		const user = await getUserBySubject(ctx.db, userId);

		let accessPhase: 'none' | 'scheduled_cancel' | 'active' = 'active';

		if (plan.tier === 'free') accessPhase = 'none';
		else if (plan.subscription?.cancelAtNextBillingDate) accessPhase = 'scheduled_cancel';

		return {
			tier: plan.tier,
			tierLabel: plan.label,
			billingManaged: user?.dodoCustomerId !== undefined,
			accessPhase
		};
	}
});

export const ensureMySubscription = mutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		await ensureCurrentUser(ctx);

		return null;
	}
});

export const checkout = action({
	args: {
		tier: v.string(),
		interval: vBillingInterval
	},
	returns: v.object({
		checkout_url: v.string(),
		mode: vDodoMode,
		attemptId: v.optional(v.string()),
		sessionId: v.optional(v.string())
	}),
	handler: async (
		ctx,
		{ tier, interval }
	): Promise<{ checkout_url: string; mode: DodoMode; attemptId?: string; sessionId?: string }> => {
		const identity = await requireIdentity(ctx);

		if (tier === 'free') throw new Error('The Free tier does not use checkout.');

		assertCheckoutConfigured();
		const mode = publicMode(readDodoEnvironment(env));

		const productId: string | null = await ctx.runQuery(internal.pricingData.getTierProduct, {
			tierId: tier,
			interval
		});

		if (!productId) {
			throw new Error(`No ${interval} checkout product is configured for tier "${tier}".`);
		}

		let providerRequests = 0;

		const budget = () => {
			providerRequests += 1;

			if (providerRequests > CHECKOUT_PROVIDER_REQUEST_BUDGET) {
				throw new Error('Checkout is taking too long to confirm. Try again in a moment.');
			}
		};

		const existingCustomerId = await ctx.runQuery(internal.billingCustomers.getDodoCustomerId, {
			userId: identity.subject
		});

		if (existingCustomerId) {
			budget();

			if (
				await ctx.runAction(internal.pricing.hasLiveSubscription, {
					dodoCustomerId: existingCustomerId
				})
			) {
				throw new ConvexError(LIVE_SUBSCRIPTION_CHECKOUT_ERROR);
			}
		}

		const reserved = await ctx.runMutation(internal.billing.reserveCheckoutSession, {
			userId: identity.subject,
			tierId: tier,
			interval,
			productId,
			now: Date.now()
		});

		if (reserved.kind === 'existing') {
			return {
				checkout_url: reserved.checkoutUrl,
				mode,
				attemptId: reserved.attemptId,
				sessionId: reserved.sessionId
			};
		}

		if (reserved.sessionId) {
			budget();

			const recovered = await ctx.runAction(internal.pricing.recoverCheckoutSession, {
				sessionId: reserved.sessionId
			});

			if (recovered.checkoutUrl) {
				await ctx.runMutation(internal.billing.attachCheckoutSession, {
					userId: identity.subject,
					attemptId: reserved.attemptId,
					checkoutUrl: recovered.checkoutUrl
				});

				return {
					checkout_url: recovered.checkoutUrl,
					mode,
					attemptId: reserved.attemptId,
					sessionId: reserved.sessionId
				};
			}

			if (recovered.status === 'succeeded') {
				throw new Error(
					'A payment for this checkout is confirming. It will activate shortly; do not pay again.'
				);
			}

			if (recovered.status !== 'failed') {
				throw new Error(
					'Checkout is still confirming with the payment provider. Try again in a moment.'
				);
			}

			await ctx.runMutation(internal.billing.failCheckoutAttempt, {
				userId: identity.subject,
				attemptId: reserved.attemptId
			});
			throw new Error('The previous checkout attempt failed. Start checkout again.');
		}

		if (
			reserved.outcome === 'create_ambiguous' &&
			(!reserved.createRequest || !reserved.idempotencyKey)
		) {
			throw new Error(
				'This older checkout needs provider reconciliation before retrying. Contact billing support.'
			);
		}

		// The pricing site can start checkout before the app ever created the
		// users row that stores the Dodo customer.
		await ctx.runMutation(api.billing.ensureMySubscription, {});

		const dodoCustomerId: string = await ctx.runAction(internal.pricing.ensureCustomer, {
			userId: identity.subject,
			email: identity.email,
			name: identity.name ?? identity.nickname ?? identity.email ?? identity.subject
		});

		const freshUrls = resolveMarketingPricingUrls(env, tier);

		if (
			reserved.outcome === 'create_ambiguous' &&
			reserved.outcomeUpdatedAt !== undefined &&
			Date.now() < reserved.outcomeUpdatedAt + AMBIGUOUS_CREATE_RETRY_MS
		) {
			throw new Error(
				'Checkout is still confirming with the payment provider. Try again in a moment.'
			);
		}

		budget();
		await ctx.runAction(internal.pricing.validateCheckoutProduct, {
			productId: reserved.createRequest?.productId ?? reserved.productId,
			interval: reserved.interval
		});

		const frozen = await ctx.runMutation(internal.billing.freezeCheckoutCreateRequest, {
			userId: identity.subject,
			attemptId: reserved.attemptId,
			createBody: {
				productId: reserved.productId,
				returnUrl: freshUrls.return_url,
				cancelUrl: freshUrls.cancel_url,
				dodoCustomerId
			}
		});

		const createBody = frozen.createRequest;
		const idempotencyKey = frozen.idempotencyKey;

		let created: { checkoutUrl: string | null; sessionId: string };

		try {
			budget();
			created = await ctx.runAction(internal.pricing.createCheckoutSession, {
				attemptId: reserved.attemptId,
				userId: identity.subject,
				tierId: tier,
				productId: createBody.productId,
				interval: reserved.interval,
				returnUrl: createBody.returnUrl,
				cancelUrl: createBody.cancelUrl,
				dodoCustomerId: createBody.dodoCustomerId,
				idempotencyKey
			});
		} catch {
			await ctx.runMutation(internal.billing.markCheckoutAttemptAmbiguous, {
				userId: identity.subject,
				attemptId: reserved.attemptId
			});
			throw new Error(
				'Checkout could not be confirmed. Check its status before trying another payment.'
			);
		}

		if (!created.checkoutUrl) {
			await ctx.runMutation(internal.billing.failCheckoutAttempt, {
				userId: identity.subject,
				attemptId: reserved.attemptId
			});
			throw new Error('Checkout session did not return a URL. Start checkout again.');
		}

		const attached = await ctx.runMutation(internal.billing.attachCheckoutSession, {
			userId: identity.subject,
			attemptId: reserved.attemptId,
			checkoutUrl: created.checkoutUrl,
			sessionId: created.sessionId,
			createBody,
			idempotencyKey
		});

		if (!attached) {
			console.warn(
				`Checkout attempt ${reserved.attemptId} for user ${identity.subject} finished after its reservation moved on; returning the created link.`
			);
		}

		return {
			checkout_url: created.checkoutUrl,
			mode,
			attemptId: reserved.attemptId,
			sessionId: created.sessionId
		};
	}
});

export const reserveCheckoutSession = internalMutation({
	args: {
		userId: v.string(),
		attemptId: v.optional(v.string()),
		tierId: v.string(),
		interval: vBillingInterval,
		productId: v.string(),
		now: v.number()
	},
	returns: v.union(
		v.object({
			kind: v.literal('existing'),
			attemptId: v.string(),
			checkoutUrl: v.string(),
			sessionId: v.optional(v.string()),
			idempotencyKey: v.optional(v.string()),
			outcome: v.optional(v.string()),
			outcomeUpdatedAt: v.optional(v.number()),
			createRequest: v.optional(
				v.object({
					productId: v.string(),
					returnUrl: v.string(),
					cancelUrl: v.string(),
					dodoCustomerId: v.string()
				})
			)
		}),
		v.object({
			kind: v.literal('create'),
			attemptId: v.string(),
			interval: vBillingInterval,
			productId: v.string(),
			sessionId: v.optional(v.string()),
			idempotencyKey: v.optional(v.string()),
			outcome: v.optional(v.string()),
			outcomeUpdatedAt: v.optional(v.number()),
			createRequest: v.optional(
				v.object({
					productId: v.string(),
					returnUrl: v.string(),
					cancelUrl: v.string(),
					dodoCustomerId: v.string()
				})
			)
		})
	),
	handler: async (ctx, args) => {
		const openRows = await ctx.db
			.query('billingCheckoutSessions')
			.withIndex('by_userId_and_attemptId', (query) => query.eq('userId', args.userId))
			.take(MAX_OPEN_CHECKOUT_SELECTIONS + 1);

		const retainedRows = await ctx.db
			.query('billingCheckoutAttempts')
			.withIndex('by_userId', (query) => query.eq('userId', args.userId))
			.take(MAX_OPEN_CHECKOUT_SELECTIONS + 1);

		const ambiguousMatch = [...openRows, ...retainedRows].find(
			(attempt) =>
				attempt.outcome === 'create_ambiguous' &&
				!attempt.dodoSessionId &&
				attempt.tierId === args.tierId &&
				attempt.interval === args.interval &&
				attempt.productId === args.productId
		);

		const existing = openRows[0];

		const ambiguousMatchRetained =
			ambiguousMatch !== undefined && !openRows.some((row) => row._id === ambiguousMatch._id);

		if (ambiguousMatchRetained) {
			return {
				kind: 'create' as const,
				attemptId: ambiguousMatch.attemptId,
				interval: ambiguousMatch.interval,
				productId: ambiguousMatch.productId,
				idempotencyKey: ambiguousMatch.idempotencyKey,
				outcome: ambiguousMatch.outcome,
				outcomeUpdatedAt: ambiguousMatch.outcomeUpdatedAt,
				createRequest: ambiguousMatch.createRequest
			};
		}

		// An ambiguous attempt for this exact selection resumes with its original
		// key even past local expiry; the provider may still hold the key. A
		// retained ambiguous match already returned above, so only the open row
		// can match here.
		const ambiguousForSelection =
			ambiguousMatch !== undefined &&
			existing?.attemptId === ambiguousMatch.attemptId &&
			existing.expiresAt <= args.now;

		if (
			existing &&
			(existing.expiresAt > args.now || ambiguousForSelection) &&
			existing.tierId === args.tierId &&
			existing.interval === args.interval &&
			existing.productId === args.productId
		) {
			if (!checkoutOutcomeIsTerminal(existing.outcome)) {
				if (existing.checkoutUrl) {
					return {
						kind: 'existing' as const,
						attemptId: existing.attemptId,
						checkoutUrl: existing.checkoutUrl,
						sessionId: existing.dodoSessionId
					};
				}

				return {
					kind: 'create' as const,
					attemptId: existing.attemptId,
					interval: existing.interval,
					productId: existing.productId,
					sessionId: existing.dodoSessionId,
					idempotencyKey: existing.idempotencyKey,
					outcome: existing.outcome,
					outcomeUpdatedAt: existing.outcomeUpdatedAt,
					createRequest: existing.createRequest
				};
			}
		}

		if (retainedRows.length >= MAX_OPEN_CHECKOUT_SELECTIONS) {
			throw new Error(
				'Too many unresolved or recent checkout selections. Contact billing support to reconcile existing checkouts before starting another.'
			);
		}

		if (existing) await archiveCheckoutAttempt(ctx, existing, args.now);

		const reservation = {
			userId: args.userId,
			attemptId: args.attemptId ?? crypto.randomUUID(),
			tierId: args.tierId,
			interval: args.interval,
			productId: args.productId,
			outcome: 'reserved' as const,
			idempotencyKey: `sprocket-checkout:${crypto.randomUUID()}`,
			outcomeUpdatedAt: args.now,
			expiresAt: args.now + CHECKOUT_SESSION_TTL_MS
		};

		await ctx.db.insert('billingCheckoutSessions', reservation);

		return {
			kind: 'create' as const,
			attemptId: reservation.attemptId,
			interval: args.interval,
			productId: args.productId,
			idempotencyKey: reservation.idempotencyKey,
			outcome: reservation.outcome
		};
	}
});

async function archiveCheckoutAttempt(
	ctx: MutationCtx,
	attempt: Doc<'billingCheckoutSessions'>,
	now: number
): Promise<void> {
	const terminal = checkoutOutcomeIsTerminal(attempt.outcome);

	await ctx.db.insert('billingCheckoutAttempts', {
		userId: attempt.userId,
		attemptId: attempt.attemptId,
		tierId: attempt.tierId,
		interval: attempt.interval,
		productId: attempt.productId,
		checkoutUrl: terminal ? undefined : attempt.checkoutUrl,
		dodoSessionId: attempt.dodoSessionId,
		idempotencyKey: terminal ? undefined : attempt.idempotencyKey,
		outcome: attempt.outcome,
		outcomeUpdatedAt: attempt.outcomeUpdatedAt ?? now,
		createRequest: terminal ? undefined : attempt.createRequest,
		createStartedAt: attempt.createStartedAt,
		expiresAt: attempt.expiresAt
	});
	await ctx.db.delete('billingCheckoutSessions', attempt._id);
}

export const attachCheckoutSession = internalMutation({
	args: {
		userId: v.string(),
		attemptId: v.string(),
		checkoutUrl: v.string(),
		sessionId: v.optional(v.string()),
		idempotencyKey: v.optional(v.string()),
		createBody: v.optional(
			v.object({
				productId: v.string(),
				returnUrl: v.string(),
				cancelUrl: v.string(),
				dodoCustomerId: v.string()
			})
		)
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const reservation = await ctx.db
			.query('billingCheckoutSessions')
			.withIndex('by_userId_and_attemptId', (query) => query.eq('userId', args.userId))
			.unique();

		if (!reservation || reservation.attemptId !== args.attemptId) {
			const retained = await ctx.db
				.query('billingCheckoutAttempts')
				.withIndex('by_userId_and_attemptId', (query) =>
					query.eq('userId', args.userId).eq('attemptId', args.attemptId)
				)
				.unique();

			if (retained && !checkoutOutcomeIsTerminal(retained.outcome))
				await ctx.db.patch('billingCheckoutAttempts', retained._id, {
					checkoutUrl: args.checkoutUrl,
					dodoSessionId: args.sessionId ?? retained.dodoSessionId,
					idempotencyKey: args.idempotencyKey ?? retained.idempotencyKey,
					createRequest: args.createBody ?? retained.createRequest,
					outcome: 'created',
					outcomeUpdatedAt: Date.now()
				});

			return false;
		}

		if (checkoutOutcomeIsTerminal(reservation.outcome)) return false;

		await ctx.db.patch('billingCheckoutSessions', reservation._id, {
			checkoutUrl: args.checkoutUrl,
			dodoSessionId: args.sessionId ?? reservation.dodoSessionId,
			outcome: 'created',
			outcomeUpdatedAt: Date.now(),
			idempotencyKey: args.idempotencyKey ?? reservation.idempotencyKey,
			createRequest: args.createBody ?? reservation.createRequest
		});

		return true;
	}
});

type CheckoutAttemptRef = {
	row: Doc<'billingCheckoutSessions'> | Doc<'billingCheckoutAttempts'>;
	table: 'billingCheckoutSessions' | 'billingCheckoutAttempts';
};

async function findCheckoutAttempt(
	ctx: QueryCtx,
	userId: string,
	attemptId: string
): Promise<CheckoutAttemptRef | null> {
	const current = await ctx.db
		.query('billingCheckoutSessions')
		.withIndex('by_userId_and_attemptId', (query) =>
			query.eq('userId', userId).eq('attemptId', attemptId)
		)
		.unique();

	if (current) return { row: current, table: 'billingCheckoutSessions' };

	const retained = await ctx.db
		.query('billingCheckoutAttempts')
		.withIndex('by_userId_and_attemptId', (query) =>
			query.eq('userId', userId).eq('attemptId', attemptId)
		)
		.unique();

	return retained ? { row: retained, table: 'billingCheckoutAttempts' } : null;
}

export const freezeCheckoutCreateRequest = internalMutation({
	args: {
		userId: v.string(),
		attemptId: v.string(),
		createBody: v.object({
			productId: v.string(),
			returnUrl: v.string(),
			cancelUrl: v.string(),
			dodoCustomerId: v.string()
		})
	},
	returns: v.object({
		idempotencyKey: v.string(),
		createRequest: v.object({
			productId: v.string(),
			returnUrl: v.string(),
			cancelUrl: v.string(),
			dodoCustomerId: v.string()
		})
	}),
	handler: async (ctx, args) => {
		const match = await findCheckoutAttempt(ctx, args.userId, args.attemptId);

		if (!match) throw new Error('Unknown checkout attempt.');

		const { row: reservation, table } = match;

		if (checkoutOutcomeIsTerminal(reservation.outcome))
			throw new Error('This checkout already completed.');

		if (
			(!reservation.createRequest || !reservation.idempotencyKey) &&
			reservation.outcome !== 'reserved'
		) {
			throw new Error(
				'This legacy checkout needs provider confirmation. Contact billing support before retrying.'
			);
		}

		if (reservation.outcome === 'create_ambiguous' && !reservation.dodoSessionId) {
			const confirmedWindowMs = Number(env.DODO_CHECKOUT_IDEMPOTENCY_WINDOW_MS);

			if (
				!Number.isSafeInteger(confirmedWindowMs) ||
				confirmedWindowMs <= 0 ||
				reservation.createStartedAt === undefined ||
				Date.now() < reservation.createStartedAt ||
				Date.now() >= reservation.createStartedAt + confirmedWindowMs
			) {
				throw new Error(
					'This checkout needs provider confirmation before retrying. Contact billing support; do not start another payment.'
				);
			}
		}

		const createRequest = reservation.createRequest ?? args.createBody;
		const idempotencyKey = reservation.idempotencyKey ?? `sprocket-checkout:${crypto.randomUUID()}`;

		if (reservation.dodoSessionId) {
			return { idempotencyKey, createRequest };
		}

		const patch = {
			createRequest,
			idempotencyKey,
			createStartedAt: reservation.createStartedAt ?? Date.now(),
			outcome: 'create_ambiguous' as const,
			outcomeUpdatedAt:
				reservation.outcome === 'create_ambiguous' ? reservation.outcomeUpdatedAt : Date.now()
		};

		await ctx.db.patch(table, reservation._id, patch);

		return { idempotencyKey, createRequest };
	}
});

export const markCheckoutAttemptAmbiguous = internalMutation({
	args: { userId: v.string(), attemptId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const match = await findCheckoutAttempt(ctx, args.userId, args.attemptId);

		if (!match || checkoutOutcomeIsTerminal(match.row.outcome) || match.row.dodoSessionId)
			return null;

		await ctx.db.patch(match.table, match.row._id, {
			outcome: 'create_ambiguous',
			outcomeUpdatedAt: Date.now()
		});

		return null;
	}
});

export const failCheckoutAttempt = internalMutation({
	args: { userId: v.string(), attemptId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const match = await findCheckoutAttempt(ctx, args.userId, args.attemptId);

		if (!match || match.row.outcome === 'paid') return null;

		await ctx.db.patch(match.table, match.row._id, {
			outcome: 'failed',
			outcomeUpdatedAt: Date.now(),
			checkoutUrl: undefined,
			createRequest: undefined,
			idempotencyKey: undefined
		});

		return null;
	}
});

export const cleanupCheckoutHistory = internalMutation({
	args: {
		table: v.optional(
			v.union(v.literal('billingCheckoutSessions'), v.literal('billingCheckoutAttempts'))
		),
		cursor: v.optional(v.union(v.string(), v.null()))
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const table = args.table ?? 'billingCheckoutSessions';

		const page = await ctx.db.query(table).paginate({
			cursor: args.cursor ?? null,
			numItems: CHECKOUT_CLEANUP_PAGE_SIZE
		});

		const cutoff = Date.now() - CHECKOUT_HISTORY_RETENTION_MS;

		for (const row of page.page) {
			const terminal = checkoutOutcomeIsTerminal(row.outcome);

			// Provider sessions expire 24h after creation and ambiguous creates stop
			// retrying long before this cutoff, so no row past it can still be paid
			// through or resumed. Webhooks for old payments match by metadata, not rows.
			if (
				(terminal && (row.outcomeUpdatedAt ?? row._creationTime) <= cutoff) ||
				row.expiresAt <= cutoff
			) {
				await ctx.db.delete(table, row._id);
			} else if (terminal && (row.checkoutUrl || row.createRequest || row.idempotencyKey)) {
				await ctx.db.patch(table, row._id, {
					checkoutUrl: undefined,
					createRequest: undefined,
					idempotencyKey: undefined
				});
			}
		}

		if (!page.isDone) {
			await ctx.scheduler.runAfter(1_000, internal.billing.cleanupCheckoutHistory, {
				table,
				cursor: page.continueCursor
			});
		} else if (table === 'billingCheckoutSessions') {
			await ctx.scheduler.runAfter(1_000, internal.billing.cleanupCheckoutHistory, {
				table: 'billingCheckoutAttempts'
			});
		}

		return null;
	}
});

export const getCheckoutStatus = action({
	args: { attemptId: v.string() },
	returns: v.object({
		attemptId: v.string(),
		status: vCheckoutAttemptStatus,
		mode: vDodoMode,
		activated: v.optional(v.boolean()),
		checkout_url: v.optional(v.string()),
		sessionId: v.optional(v.string()),
		expiresAt: v.optional(v.number())
	}),
	handler: async (
		ctx,
		{ attemptId }
	): Promise<{
		attemptId: string;
		status: 'awaiting_payment' | 'pending' | 'succeeded' | 'failed' | 'expired' | 'unknown';
		mode: DodoMode;
		activated?: boolean;
		checkout_url?: string;
		sessionId?: string;
		expiresAt?: number;
	}> => {
		const identity = await requireIdentity(ctx);

		const attempt = await ctx.runQuery(internal.billing.lookupCheckoutAttempt, {
			userId: identity.subject,
			attemptId
		});

		if (!attempt) throw new Error('Unknown checkout attempt.');

		const mode = publicMode(readDodoEnvironment(env));

		const now = Date.now();

		if (attempt.outcome === 'paid') {
			const activated = await ctx.runQuery(internal.billing.attemptActivated, {
				userId: identity.subject,
				tierId: attempt.tierId,
				interval: attempt.interval,
				now
			});

			return { attemptId, mode, status: 'succeeded', sessionId: attempt.dodoSessionId, activated };
		}

		if (attempt.outcome === 'failed') {
			return { attemptId, mode, status: 'failed', expiresAt: attempt.expiresAt };
		}

		const locallyExpired = attempt.expiresAt <= now;

		if (
			locallyExpired &&
			attempt.outcome === 'reserved' &&
			!attempt.createRequest &&
			!attempt.checkoutUrl &&
			!attempt.dodoSessionId
		) {
			return { attemptId, mode, status: 'expired', expiresAt: attempt.expiresAt };
		}

		if (!env.DODO_PAYMENTS_API_KEY?.trim()) {
			return {
				attemptId,
				status: 'unknown',
				mode,
				checkout_url: attempt.checkoutUrl,
				sessionId: attempt.dodoSessionId,
				expiresAt: attempt.expiresAt
			};
		}

		if (attempt.dodoSessionId) {
			let provider;

			try {
				provider = await ctx.runAction(internal.pricing.recoverCheckoutSession, {
					sessionId: attempt.dodoSessionId
				});
			} catch {
				return {
					attemptId,
					status: 'unknown',
					mode,
					checkout_url: attempt.checkoutUrl,
					sessionId: attempt.dodoSessionId,
					expiresAt: attempt.expiresAt
				};
			}

			switch (provider.status) {
				case 'succeeded':
					return {
						attemptId,
						status: 'succeeded',
						mode,
						sessionId: attempt.dodoSessionId,
						activated: await ctx.runQuery(internal.billing.attemptActivated, {
							userId: identity.subject,
							tierId: attempt.tierId,
							interval: attempt.interval,
							now
						})
					};
				case 'failed':
					await ctx.runMutation(internal.billing.failCheckoutAttempt, {
						userId: identity.subject,
						attemptId
					});

					return { attemptId, mode, status: 'failed', expiresAt: attempt.expiresAt };
				case 'awaiting_payment':
					return {
						attemptId,
						status: 'awaiting_payment',
						mode,
						checkout_url: attempt.checkoutUrl,
						sessionId: attempt.dodoSessionId,
						expiresAt: attempt.expiresAt
					};
				default:
					return {
						attemptId,
						status: 'pending',
						mode,
						checkout_url: attempt.checkoutUrl,
						sessionId: attempt.dodoSessionId,
						expiresAt: attempt.expiresAt
					};
			}
		}

		if (locallyExpired && attempt.outcome === 'create_ambiguous') {
			return { attemptId, mode, status: 'unknown', expiresAt: attempt.expiresAt };
		}

		return {
			attemptId,
			status: attempt.outcome === 'create_ambiguous' ? 'pending' : 'awaiting_payment',
			mode,
			expiresAt: attempt.expiresAt
		};
	}
});

export const lookupCheckoutAttempt = internalQuery({
	args: { userId: v.string(), attemptId: v.string() },
	returns: v.union(
		v.object({
			attemptId: v.string(),
			tierId: v.string(),
			interval: vBillingInterval,
			productId: v.string(),
			checkoutUrl: v.optional(v.string()),
			dodoSessionId: v.optional(v.string()),
			outcome: v.optional(v.string()),
			idempotencyKey: v.optional(v.string()),
			outcomeUpdatedAt: v.optional(v.number()),
			createRequest: v.optional(
				v.object({
					productId: v.string(),
					returnUrl: v.string(),
					cancelUrl: v.string(),
					dodoCustomerId: v.string()
				})
			),
			expiresAt: v.number()
		}),
		v.null()
	),
	handler: async (ctx, { userId, attemptId }) => {
		const current = await ctx.db
			.query('billingCheckoutSessions')
			.withIndex('by_userId_and_attemptId', (query) =>
				query.eq('userId', userId).eq('attemptId', attemptId)
			)
			.unique();

		const retained =
			current ??
			(await ctx.db
				.query('billingCheckoutAttempts')
				.withIndex('by_userId_and_attemptId', (query) =>
					query.eq('userId', userId).eq('attemptId', attemptId)
				)
				.unique());

		if (!retained) return null;

		return {
			attemptId: retained.attemptId,
			tierId: retained.tierId,
			interval: retained.interval,
			productId: retained.productId,
			checkoutUrl: retained.checkoutUrl,
			dodoSessionId: retained.dodoSessionId,
			outcome: retained.outcome,
			idempotencyKey: retained.idempotencyKey,
			outcomeUpdatedAt: retained.outcomeUpdatedAt,
			createRequest: retained.createRequest,
			expiresAt: retained.expiresAt
		};
	}
});

export const attemptActivated = internalQuery({
	args: {
		userId: v.string(),
		tierId: v.string(),
		interval: vBillingInterval,
		now: v.number()
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const plan = await resolvePlan(ctx, args.userId, args.now);

		return plan.tier === args.tierId && plan.subscription?.interval === args.interval;
	}
});

export const customerPortal = action({
	args: {},
	returns: v.object({ portal_url: v.string() }),
	handler: async (ctx): Promise<{ portal_url: string }> => {
		assertPaymentsConfigured();
		const userId = await getUserId(ctx);

		const dodoCustomerId = await ctx.runQuery(internal.billingCustomers.getDodoCustomerId, {
			userId
		});

		if (!dodoCustomerId) throw new Error('This account does not have a billing customer.');

		const portal = await ctx.runAction(internal.pricing.createCustomerPortal, {
			dodoCustomerId
		});

		return { portal_url: portal.portal_url };
	}
});
