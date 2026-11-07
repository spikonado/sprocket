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
import type { Doc, Id } from '@convex/_generated/dataModel';
import type { WithoutSystemFields } from 'convex/server';
import { ensureCurrentUser, getUserBySubject, getUserId, requireIdentity } from '@convex/lib/auth';
import {
	advanceWatermarks,
	computeAccess,
	identityTakeoverAllowed,
	isStalePayload,
	isStaleStatus,
	isStaleTerm,
	isStaleSchedule,
	normalizedTerminalOrHold,
	payloadPosition,
	projectionMatches,
	resolveEffectiveTier,
	type PayloadSource,
	type SubscriptionPayload
} from '@convex/lib/subscriptionProjection';
import { resolveMarketingPricingUrls } from '@convex/lib/marketingOrigin';
import { resetUsage } from '@convex/lib/quota';
import {
	accessPhaseAt,
	displayAccessPhase,
	displayTier,
	ensureSubscription,
	getSubscriptionDoc,
	getTierLabel,
	isOperatorGrant,
	listSubscriptionDocs
} from '@convex/lib/tiers';
import {
	vBillingInterval,
	vCheckoutAttemptStatus,
	vDodoMode,
	vSubscriptionStatus,
	vSubscriptionTier
} from '@convex/lib/validators';
import { scheduleSubscriptionExpiry } from '@convex/subscriptionExpiry';
import { lookupTierForProduct } from '@convex/pricingData';
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

type PaidAccessState = 'active' | 'scheduled_cancel' | 'ended' | 'none';

type SubscriptionActivityRow = Pick<
	Doc<'subscriptions'>,
	| 'tier'
	| 'status'
	| 'dodoSubscriptionId'
	| 'accessPhase'
	| 'cancelAtNextBillingDate'
	| 'terminalConfirmed'
>;

function paidAccessState(subscription: SubscriptionActivityRow | null): PaidAccessState {
	if (!subscription || subscription.tier === 'free') return 'none';

	const phase = displayAccessPhase(subscription);

	if (phase === 'paid' || phase === 'renewal_processing') {
		return subscription.cancelAtNextBillingDate === true ? 'scheduled_cancel' : 'active';
	}

	if (subscription.dodoSubscriptionId) {
		return subscription.terminalConfirmed === true ? 'none' : 'ended';
	}

	return 'none';
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
		const subscription = await getSubscriptionDoc(ctx, userId);
		const tier = displayTier(subscription);

		const user = await getUserBySubject(ctx.db, userId);

		const accessPhase = paidAccessState(subscription);

		return {
			tier,
			tierLabel: await getTierLabel(ctx, tier),
			billingManaged: user?.dodoCustomerId !== undefined,
			accessPhase
		};
	}
});

export const ensureMySubscription = mutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const userId = await getUserId(ctx);
		await ensureCurrentUser(ctx);
		await ensureSubscription(ctx, userId);
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
				attemptId,
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
						sessionId: attempt.dodoSessionId
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
		attemptId: v.string(),
		tierId: v.string(),
		interval: vBillingInterval,
		now: v.number()
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const subscriptions = await listSubscriptionDocs(ctx, args.userId);

		for (const subscription of subscriptions) {
			if (accessPhaseAt(subscription, args.now) === 'none') continue;

			if (subscription.checkoutAttemptId !== args.attemptId) continue;

			if (
				subscription.tier !== args.tierId ||
				(subscription.billingInterval ?? 'monthly') !== args.interval
			) {
				continue;
			}

			return true;
		}

		return false;
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

export const upsertDodoSubscription = internalMutation({
	args: {
		userId: v.optional(v.string()),
		tier: v.optional(v.string()),
		checkoutAttemptId: v.optional(v.string()),
		dodoSubscriptionId: v.string(),
		dodoProductId: v.string(),
		dodoCustomerId: v.string(),
		status: v.union(
			vSubscriptionStatus,
			v.literal('paused'),
			v.literal('pending'),
			v.literal('past_due')
		),
		eventAt: v.number(),
		billingInterval: vBillingInterval,
		billingPeriodStart: v.number(),
		billingPeriodEnd: v.number(),
		cancelAtNextBillingDate: v.boolean(),
		scheduledChange: v.optional(
			v.union(
				v.object({ id: v.string(), productId: v.string(), effectiveAt: v.number() }),
				v.null()
			)
		)
	},
	returns: v.object({
		outcome: v.union(
			v.literal('applied'),
			v.literal('stale'),
			v.literal('noop'),
			v.literal('competing'),
			v.literal('unresolved')
		),
		detail: v.optional(v.string())
	}),
	handler: async (ctx, args) =>
		await applyDodoSubscriptionProjection(ctx, { ...args, source: 'webhook' })
});

type DodoSubscriptionEventArgs = PayloadSource & {
	userId?: string;
	tier?: string;
	checkoutAttemptId?: string;
	dodoSubscriptionId: string;
	dodoProductId: string;
	dodoCustomerId: string;
	status: SubscriptionPayload['status'];
	billingInterval: 'monthly' | 'annual';
	billingPeriodStart: number;
	billingPeriodEnd: number;
	cancelAtNextBillingDate: boolean;
	scheduledChange?: { id: string; productId: string; effectiveAt: number } | null;
};

export type ProjectionOutcome = {
	outcome: 'applied' | 'stale' | 'noop' | 'competing' | 'unresolved';
	detail?: string;
};

type ReconcileRequest = {
	subscriptionId: Id<'subscriptions'>;
	dodoSubscriptionId: string;
	projectionRevision: number;
	force?: boolean;
};

type ProjectionWrite = {
	kind: 'write';
	now: number;
	existingId: Id<'subscriptions'> | undefined;
	subscription: WithoutSystemFields<Doc<'subscriptions'>> & {
		dodoSubscriptionId: string;
		projectionRevision: number;
	};
	paidAttempt: CheckoutAttemptRef | null;
	linkCustomer: { userId: Id<'users'>; dodoCustomerId: string } | null;
	supersededDodoSubscriptionId: string | null;
	reconcileAfterWrite: boolean;
	resetUsage: boolean;
	outcome: 'applied' | 'noop';
};

type ProjectionPlan =
	| { kind: 'rejected'; result: ProjectionOutcome; reconcile?: ReconcileRequest }
	| { kind: 'converged'; subscriptionId: Id<'subscriptions'>; observedAt: number | undefined }
	| ProjectionWrite;

export async function applyDodoSubscriptionProjection(
	ctx: MutationCtx,
	args: DodoSubscriptionEventArgs
): Promise<ProjectionOutcome> {
	return await writeSubscriptionProjection(
		ctx,
		await planSubscriptionProjection(ctx, args, Date.now())
	);
}

function forcedReconcile(
	existing: Doc<'subscriptions'>,
	dodoSubscriptionId: string
): ReconcileRequest {
	return {
		subscriptionId: existing._id,
		dodoSubscriptionId,
		projectionRevision: existing.projectionRevision ?? 0,
		force: true
	};
}

async function planSubscriptionProjection(
	ctx: QueryCtx,
	args: DodoSubscriptionEventArgs,
	now: number
): Promise<ProjectionPlan> {
	if (!Number.isFinite(args.billingPeriodStart) || !Number.isFinite(args.billingPeriodEnd)) {
		throw new Error('Dodo billing period boundaries must be finite.');
	}

	if (args.billingPeriodEnd <= args.billingPeriodStart) {
		throw new Error('Dodo billing period must have a positive duration.');
	}

	if (args.status === 'paused' || args.status === 'pending') {
		return {
			kind: 'rejected',
			result: {
				outcome: 'unresolved',
				detail: `Unsupported Dodo subscription status "${args.status}".`
			}
		};
	}

	const knownCustomer = await ctx.db
		.query('users')
		.withIndex('by_dodoCustomerId', (query) => query.eq('dodoCustomerId', args.dodoCustomerId))
		.unique();

	const userId = args.userId ?? knownCustomer?.subject;

	if (!userId) {
		return {
			kind: 'rejected',
			result: {
				outcome: 'unresolved',
				detail: `Dodo subscription ${args.dodoSubscriptionId} has no mapped Sprocket user.`
			}
		};
	}

	if (knownCustomer && knownCustomer.subject !== userId) {
		throw new Error('Dodo subscription customer does not match this account.');
	}

	const existing = await getSubscriptionDoc(ctx, userId);
	const sameIdentity = existing?.dodoSubscriptionId === args.dodoSubscriptionId;

	// Dodo's failed status is mandate-creation failure, not a failed upgrade charge.
	if (sameIdentity && args.status === 'failed' && existing.status !== 'failed') {
		return {
			kind: 'rejected',
			result: {
				outcome: 'unresolved',
				detail: 'Mandate failure conflicts with an established subscription.'
			},
			reconcile: forcedReconcile(existing, args.dodoSubscriptionId)
		};
	}

	if (existing?.status === 'active' && existing.tier !== 'free' && isOperatorGrant(existing)) {
		return {
			kind: 'rejected',
			result: { outcome: 'competing', detail: 'Operator-granted subscription preserved.' }
		};
	}

	if (existing?.dodoSubscriptionId !== args.dodoSubscriptionId) {
		const superseded = await ctx.db
			.query('supersededSubscriptions')
			.withIndex('by_dodoSubscriptionId', (query) =>
				query.eq('dodoSubscriptionId', args.dodoSubscriptionId)
			)
			.unique();

		if (superseded) {
			return {
				kind: 'rejected',
				result: {
					outcome: 'stale',
					detail: `Superseded Dodo subscription ${args.dodoSubscriptionId}.`
				}
			};
		}
	}

	const source: PayloadSource =
		args.source === 'webhook'
			? { source: 'webhook', eventAt: args.eventAt }
			: { source: 'observation', observedAt: args.observedAt };

	const payload = {
		...source,
		dodoSubscriptionId: args.dodoSubscriptionId,
		dodoProductId: args.dodoProductId,
		dodoCustomerId: args.dodoCustomerId,
		status: args.status,
		billingInterval: args.billingInterval,
		billingPeriodStart: args.billingPeriodStart,
		billingPeriodEnd: args.billingPeriodEnd,
		cancelAtNextBillingDate: args.cancelAtNextBillingDate,
		scheduledChange: args.scheduledChange ?? null
	};

	const normalizedStatus = payload.status === 'past_due' ? 'on_hold' : payload.status;

	const staleStatus = isStaleStatus({ existing, payload });
	const stalePayload = isStalePayload({ existing, payload });
	const staleTerm = isStaleTerm(existing, payload);
	const staleSchedule = isStaleSchedule({ existing, payload });

	if (staleStatus && stalePayload && staleTerm && staleSchedule) {
		return { kind: 'rejected', result: { outcome: 'stale' } };
	}

	if (stalePayload && existing) {
		payload.dodoProductId = existing.dodoProductId ?? payload.dodoProductId;
		payload.billingInterval = existing.billingInterval ?? payload.billingInterval;
	}

	if (staleTerm && existing) {
		payload.billingPeriodStart = existing.billingPeriodStart ?? payload.billingPeriodStart;
		payload.billingPeriodEnd = existing.billingPeriodEnd ?? payload.billingPeriodEnd;
	}

	if (staleSchedule && existing) {
		payload.cancelAtNextBillingDate = existing.cancelAtNextBillingDate ?? false;
		payload.scheduledChange = existing.scheduledChange ?? null;
	}

	const incomingStatus =
		normalizedStatus === 'cancelled' &&
		payload.cancelAtNextBillingDate &&
		payloadPosition(payload) < payload.billingPeriodEnd
			? 'active'
			: normalizedStatus;

	const historicalFailure = normalizedTerminalOrHold(payload.status) && staleTerm;
	const keepStatus = staleStatus || historicalFailure;
	const effectiveStatus = keepStatus && existing ? existing.status : incomingStatus;

	if (
		payload.source === 'webhook' &&
		sameIdentity &&
		existing.observedAt !== undefined &&
		payload.eventAt < existing.observedAt &&
		args.billingPeriodStart <= (existing.billingPeriodStart ?? args.billingPeriodStart) &&
		!projectionMatches(existing, {
			tier: existing.tier,
			status: incomingStatus,
			dodoProductId: args.dodoProductId,
			billingInterval: args.billingInterval,
			billingPeriodStart: args.billingPeriodStart,
			billingPeriodEnd: args.billingPeriodEnd,
			cancelAtNextBillingDate: args.cancelAtNextBillingDate,
			scheduledChange: args.scheduledChange ?? null
		})
	) {
		return {
			kind: 'rejected',
			result: {
				outcome: 'unresolved',
				detail: 'Delayed webhook conflicts with a provider observation; retrieval required.'
			},
			reconcile: forcedReconcile(existing, args.dodoSubscriptionId)
		};
	}

	if (identityTakeoverAllowed(existing, payload) === 'competing') {
		return {
			kind: 'rejected',
			result: {
				outcome: 'competing',
				detail:
					`Conflicting Dodo subscription ${args.dodoSubscriptionId} while ` +
					`${existing?.dodoSubscriptionId} is not authoritatively terminal.`
			}
		};
	}

	const user = await getUserBySubject(ctx.db, userId);

	if (user?.dodoCustomerId && user.dodoCustomerId !== args.dodoCustomerId) {
		throw new Error('Dodo subscription customer does not match this account.');
	}

	const selectedAttempt = args.checkoutAttemptId
		? await findCheckoutAttempt(ctx, userId, args.checkoutAttemptId)
		: null;

	// Only the attempt this subscription actually paid through may be marked
	// paid; a different open reservation for the same account is untouched.
	const matchedAttempt =
		selectedAttempt?.row.productId === args.dodoProductId ? selectedAttempt : null;

	if (matchedAttempt && matchedAttempt.row.interval !== args.billingInterval) {
		return {
			kind: 'rejected',
			result: {
				outcome: 'unresolved',
				detail: 'Subscription interval does not match the checkout attempt.'
			}
		};
	}

	const productUnchanged =
		existing?.dodoSubscriptionId === args.dodoSubscriptionId &&
		existing.dodoProductId === args.dodoProductId;

	if (
		!stalePayload &&
		productUnchanged &&
		existing.billingInterval !== undefined &&
		existing.billingInterval !== args.billingInterval
	) {
		return {
			kind: 'rejected',
			result: { outcome: 'unresolved', detail: 'An established product changed billing interval.' }
		};
	}

	const metadataTier = productUnchanged ? (args.tier ?? null) : null;

	const resolvedTier = resolveEffectiveTier({
		existing,
		payload,
		checkoutTier: matchedAttempt?.row.tierId ?? null,
		metadataTier,
		configuredTier:
			productUnchanged || matchedAttempt || stalePayload
				? null
				: await lookupTierForProduct(ctx, payload.dodoProductId, payload.billingInterval)
	});

	if (resolvedTier.unresolved && !stalePayload) {
		return { kind: 'rejected', result: { outcome: 'unresolved', detail: resolvedTier.detail } };
	}

	const tier =
		stalePayload && existing ? existing.tier : resolvedTier.unresolved ? 'free' : resolvedTier.tier;

	const watermarks = advanceWatermarks(existing, payload, {
		status: keepStatus,
		payload: stalePayload,
		term: staleTerm,
		schedule: staleSchedule
	});

	const previousTier = sameIdentity ? existing.tier : undefined;

	// Usage resets once per confirmed effective tier change or new subscription.
	// Renewals, status-only events, scheduled changes, and unchanged-product
	// remaps keep the current reset. Each reset gets a distinct timestamp so
	// a changed quotaResetAt marks exactly one usage reset.
	const isPlanChange = previousTier !== undefined && previousTier !== tier;

	const quotaResetAt =
		!sameIdentity || (isPlanChange && !stalePayload)
			? Math.max(payloadPosition(payload), (existing?.quotaResetAt ?? -Infinity) + 1)
			: existing?.quotaResetAt;

	const terminalConfirmed =
		effectiveStatus === 'cancelled' ||
		effectiveStatus === 'expired' ||
		effectiveStatus === 'failed';

	const projected = {
		tier,
		status: effectiveStatus,
		dodoProductId: payload.dodoProductId,
		billingInterval: payload.billingInterval,
		billingPeriodStart: payload.billingPeriodStart,
		billingPeriodEnd: payload.billingPeriodEnd,
		cancelAtNextBillingDate: payload.cancelAtNextBillingDate,
		scheduledChange: payload.scheduledChange
	};

	const access = computeAccess({ ...payload, status: effectiveStatus }, now);

	// Redelivery of an already-converged projection is a no-op; watermarks
	// advance only through the applied path.
	const matches =
		sameIdentity &&
		projectionMatches(existing, projected) &&
		existing.terminalConfirmed === terminalConfirmed;

	if (
		matches &&
		watermarks.eventAt === existing.eventAt &&
		watermarks.payloadEventAt === existing.payloadEventAt &&
		watermarks.termEventAt === existing.termEventAt &&
		watermarks.scheduleEventAt === existing.scheduleEventAt
	) {
		return {
			kind: 'converged',
			subscriptionId: existing._id,
			observedAt: payload.source === 'observation' ? payload.observedAt : undefined
		};
	}

	return {
		kind: 'write',
		now,
		existingId: existing?._id,
		subscription: {
			userId,
			tier,
			status: effectiveStatus,
			...watermarks,
			providerStatus: keepStatus ? (existing?.providerStatus ?? existing?.status) : args.status,
			projectionRevision: (existing?.projectionRevision ?? 0) + 1,
			observedAt: payload.source === 'observation' ? payload.observedAt : existing?.observedAt,
			checkoutAttemptId:
				matchedAttempt?.row.attemptId ?? (sameIdentity ? existing.checkoutAttemptId : undefined),
			accessPhase: access.accessPhase,
			accessEndsAt: access.accessEndsAt,
			scheduledChange: payload.scheduledChange ?? undefined,
			billingInterval: payload.billingInterval,
			billingPeriodStart: payload.billingPeriodStart,
			billingPeriodEnd: payload.billingPeriodEnd,
			billingPeriodCheckId: existing?.billingPeriodCheckId,
			cancelAtNextBillingDate: payload.cancelAtNextBillingDate,
			quotaResetAt,
			terminalConfirmed,
			dodoSubscriptionId: payload.dodoSubscriptionId,
			dodoProductId: payload.dodoProductId
		},
		paidAttempt:
			matchedAttempt && matchedAttempt.row.outcome !== 'paid' && effectiveStatus === 'active'
				? matchedAttempt
				: null,
		linkCustomer:
			user && !user.dodoCustomerId
				? { userId: user._id, dodoCustomerId: args.dodoCustomerId }
				: null,
		// Only a webhook-confirmed new identity supersedes; observations never do.
		supersededDodoSubscriptionId:
			payload.source === 'webhook' &&
			existing?.dodoSubscriptionId &&
			existing.dodoSubscriptionId !== payload.dodoSubscriptionId
				? existing.dodoSubscriptionId
				: null,
		reconcileAfterWrite:
			payload.source === 'webhook' &&
			access.accessPhase === 'none' &&
			!terminalConfirmed &&
			(!sameIdentity || existing.accessPhase !== 'none' || existing.status !== effectiveStatus),
		resetUsage: quotaResetAt !== existing?.quotaResetAt,
		outcome: matches ? 'noop' : 'applied'
	};
}

async function writeSubscriptionProjection(
	ctx: MutationCtx,
	plan: ProjectionPlan
): Promise<ProjectionOutcome> {
	switch (plan.kind) {
		case 'rejected':
			if (plan.reconcile) {
				await ctx.scheduler.runAfter(
					0,
					internal.subscriptionReconciliation.queueReconciliation,
					plan.reconcile
				);
			}

			return plan.result;
		case 'converged':
			if (plan.observedAt !== undefined) {
				await ctx.db.patch('subscriptions', plan.subscriptionId, { observedAt: plan.observedAt });
			}

			return { outcome: 'noop' };
		case 'write':
			return await writeProjectedSubscription(ctx, plan);
	}
}

async function writeProjectedSubscription(
	ctx: MutationCtx,
	plan: ProjectionWrite
): Promise<ProjectionOutcome> {
	const { subscription } = plan;

	if (plan.paidAttempt) {
		await ctx.db.patch(plan.paidAttempt.table, plan.paidAttempt.row._id, {
			outcome: 'paid',
			outcomeUpdatedAt: plan.now,
			checkoutUrl: undefined,
			createRequest: undefined,
			idempotencyKey: undefined
		});
	}

	if (plan.linkCustomer) {
		await ctx.db.patch('users', plan.linkCustomer.userId, {
			dodoCustomerId: plan.linkCustomer.dodoCustomerId
		});
	}

	if (plan.supersededDodoSubscriptionId) {
		await ctx.db.insert('supersededSubscriptions', {
			userId: subscription.userId,
			dodoSubscriptionId: plan.supersededDodoSubscriptionId,
			supersededAt: plan.now
		});
	}

	const subscriptionId = plan.existingId ?? (await ctx.db.insert('subscriptions', subscription));

	if (plan.existingId) await ctx.db.replace('subscriptions', subscriptionId, subscription);

	if (plan.resetUsage) await resetUsage(ctx, subscription.userId, subscription, plan.now);

	await scheduleSubscriptionExpiry(ctx, { _id: subscriptionId, ...subscription });

	if (plan.reconcileAfterWrite) {
		await ctx.scheduler.runAfter(0, internal.subscriptionReconciliation.queueReconciliation, {
			subscriptionId,
			dodoSubscriptionId: subscription.dodoSubscriptionId,
			projectionRevision: subscription.projectionRevision
		});
	}

	return { outcome: plan.outcome };
}
