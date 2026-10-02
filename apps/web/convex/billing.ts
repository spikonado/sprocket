import { v } from 'convex/values';
import { internal } from '@convex/_generated/api';
import {
	action,
	env,
	internalMutation,
	internalQuery,
	mutation,
	query
} from '@convex/_generated/server';
import type { MutationCtx } from '@convex/_generated/server';
import type { Doc } from '@convex/_generated/dataModel';
import { ensureCurrentUser, getUserId, requireIdentity } from '@convex/lib/auth';
import {
	computeAccess,
	identityTakeoverAllowed,
	isStalePayload,
	isStaleStatus,
	isStaleTerm,
	isStaleSchedule,
	normalizedTerminalOrHold,
	projectionMatches,
	resolveEffectiveTier
} from '@convex/lib/subscriptionProjection';
import { resolveMarketingPricingUrls } from '@convex/lib/marketingOrigin';
import {
	ensureSubscription,
	getSubscriptionDoc,
	getTierLabel,
	listSubscriptionDocs,
	subscriptionIsActive,
	subscriptionMaterializedPhase,
	subscriptionMaterializedTier
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
	| 'billingPeriodEnded'
	| 'billingPeriodEnd'
	| 'accessPhase'
	| 'accessEndsAt'
	| 'cancelAtNextBillingDate'
	| 'terminalConfirmed'
>;

/**
 * Query-time classification without a wall clock. Reads the materialized
 * access phase/deadline for Dodo-linked rows (kept current by the expiry
 * scheduler); legacy rows without the fields fall back to the provider-confirmed
 * billing period stored on the document, never to `Date.now()`. Operator
 * grants have no provider clock and are always paid while active.
 */
function paidAccessState(subscription: SubscriptionActivityRow | null): PaidAccessState {
	if (!subscription || subscription.tier === 'free') return 'none';

	const phase = subscriptionMaterializedPhase(subscription);

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
		const tier = subscriptionMaterializedTier(subscription);

		const customer = await ctx.db
			.query('billingCustomers')
			.withIndex('by_userId', (query) => query.eq('userId', userId))
			.unique();

		const accessPhase = paidAccessState(subscription);

		return {
			tier,
			tierLabel: await getTierLabel(ctx, tier),
			billingManaged: customer !== null,
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

		// Cached display prices never authorize a purchase: revalidate the
		// operator mapping here and the provider product before freezing create.
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

		// Legacy ambiguous rows (no key, no frozen body) cannot be replayed
		// byte-identically and fail closed.
		if (
			reserved.outcome === 'create_ambiguous' &&
			(!reserved.createRequest || !reserved.idempotencyKey)
		) {
			throw new Error(
				'This older checkout needs provider reconciliation before retrying. Contact billing support.'
			);
		}

		const dodoCustomerId: string = await ctx.runAction(internal.pricing.ensureCustomer, {
			userId: identity.subject,
			email: identity.email,
			name: identity.name ?? identity.nickname ?? identity.email ?? identity.subject
		});

		const freshUrls = resolveMarketingPricingUrls(env, tier);

		// A previous create may have committed provider-side but its response
		// was lost before the session id was persisted. Reissuing the same
		// idempotency key is the only recovery Dodo supports; pace the retry.
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

		// First freeze wins for both the body and the idempotency key: the
		// returned pair is exactly what any prior provider create used.
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
			// The reservation moved on (newer selection or expiry) while the
			// provider create was in flight. Keep the created link; it is still
			// payable, and the provider enforces one active subscription.
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
			.withIndex('by_userId', (query) => query.eq('userId', args.userId))
			.take(MAX_OPEN_CHECKOUT_SELECTIONS + 1);

		const retainedRows = await ctx.db
			.query('billingCheckoutAttempts')
			.withIndex('by_userId', (query) => query.eq('userId', args.userId))
			.take(MAX_OPEN_CHECKOUT_SELECTIONS + 1);

		// Same-selection retries keep their original key and frozen request,
		// including when a response was lost before the session id was saved.
		const ambiguousMatch = [...openRows, ...retainedRows].find(
			(attempt) =>
				attempt.outcome === 'create_ambiguous' &&
				!attempt.dodoSessionId &&
				attempt.tierId === args.tierId &&
				attempt.interval === args.interval &&
				attempt.productId === args.productId
		);

		const environment = readDodoEnvironment(env);
		const existing = openRows[0];

		const ambiguousMatchRetained =
			ambiguousMatch !== undefined && !openRows.some((row) => row._id === ambiguousMatch._id);

		if (ambiguousMatchRetained) {
			if (ambiguousMatch.dodoEnvironment && ambiguousMatch.dodoEnvironment !== environment) {
				throw new Error(
					'This checkout belongs to a different payment environment. Contact billing support.'
				);
			}

			return {
				kind: 'create' as const,
				attemptId: ambiguousMatch.attemptId,
				interval: ambiguousMatch.interval,
				productId: ambiguousMatch.productId,
				// Only the persisted key is ever replayed; legacy rows without one
				// fail closed at the checkout action.
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
			// Terminal attempts never resume; the caller gets a fresh reservation.
			if (!checkoutOutcomeIsTerminal(existing.outcome)) {
				if (existing.dodoEnvironment && existing.dodoEnvironment !== environment) {
					throw new Error(
						'This checkout belongs to a different payment environment. Contact billing support.'
					);
				}

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
			dodoEnvironment: environment,
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

/** Move a superseded/expired attempt into the retained history table. */
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
		dodoEnvironment: attempt.dodoEnvironment,
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
			.withIndex('by_userId', (query) => query.eq('userId', args.userId))
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

/**
 * Resolve an attempt across the open reservation and the retained history.
 * The open table is checked first so the returned table name matches the row.
 */
async function findCheckoutAttempt(
	ctx: MutationCtx,
	userId: string,
	attemptId: string
): Promise<{
	row: Doc<'billingCheckoutSessions'> | Doc<'billingCheckoutAttempts'>;
	table: 'billingCheckoutSessions' | 'billingCheckoutAttempts';
} | null> {
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

/**
 * Freeze the create body the first time a provider create is attempted. The
 * frozen body and the persisted idempotency key are coupled: concurrent
 * callers all receive the first frozen pair, so a retry can never send a new
 * body under an old key. Rows that already paid through to a session are
 * untouched.
 */
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
			// A provider session is already attached; the frozen pair only needs
			// to be readable, so never mark a fresh create as ambiguous here.
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

		// Record the actual outcome transition time for retry pacing; the local
		// expiry keeps its original meaning.
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

/**
 * Called from the webhook path once an active subscription confirms the
 * attempt; reserved for the subscription/webhook owner to invoke.
 */
export const completeCheckoutAttempt = internalMutation({
	args: { userId: v.string(), attemptId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const reservation = await ctx.db
			.query('billingCheckoutSessions')
			.withIndex('by_userId', (query) => query.eq('userId', args.userId))
			.unique();

		if (reservation && reservation.attemptId === args.attemptId) {
			await ctx.db.patch('billingCheckoutSessions', reservation._id, {
				outcome: 'paid',
				outcomeUpdatedAt: Date.now(),
				checkoutUrl: undefined,
				createRequest: undefined,
				idempotencyKey: undefined
			});
		}

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
		// Snapshot pagination: rows compacted in this pass fall out of the
		// index range and are not revisited, and rows deleted in this pass are
		// not re-read. Concurrent inserts may shift the page window; the next
		// cron run covers anything missed.
		const table = args.table ?? 'billingCheckoutSessions';

		const page = await ctx.db.query(table).paginate({
			cursor: args.cursor ?? null,
			numItems: CHECKOUT_CLEANUP_PAGE_SIZE
		});

		const cutoff = Date.now() - CHECKOUT_HISTORY_RETENTION_MS;

		for (const row of page.page) {
			const terminal = checkoutOutcomeIsTerminal(row.outcome);

			const neverSent =
				row.outcome === 'reserved' && !row.createRequest && !row.checkoutUrl && !row.dodoSessionId;

			if (
				(terminal && (row.outcomeUpdatedAt ?? row._creationTime) <= cutoff) ||
				(neverSent && row.expiresAt <= cutoff)
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
		// True only when this account's projection shows paid access matching
		// this attempt's tier/interval. Never asserted from provider state or a
		// different attempt.
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

		const mode = publicMode(attempt.dodoEnvironment ?? readDodoEnvironment(env));

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

		// Local expiry is never proof of provider expiry. A lost create response
		// may still have committed provider-side, so a locally expired ambiguous
		// attempt stays 'pending' unless the provider resolves it below.
		const locallyExpired = attempt.expiresAt <= now;

		if (
			locallyExpired &&
			attempt.outcome === 'reserved' &&
			!attempt.createRequest &&
			!attempt.checkoutUrl &&
			!attempt.dodoSessionId
		) {
			// Reserved-but-never-sent attempts have no provider identity; the local
			// reservation is the only possible record and its expiry is final.
			return { attemptId, mode, status: 'expired', expiresAt: attempt.expiresAt };
		}

		const environment = readDodoEnvironment(env);

		const environmentMismatch =
			attempt.dodoEnvironment !== undefined && attempt.dodoEnvironment !== environment;

		if (!env.DODO_PAYMENTS_API_KEY?.trim() || environmentMismatch) {
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

			// The provider still knows the session, so it outlives the local
			// expiry; report the authoritative status.
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
			// Status lookup is read-only. Recovery uses the explicit checkout
			// retry path; POST /checkouts is not a provider lookup operation.
			return { attemptId, mode, status: 'unknown', expiresAt: attempt.expiresAt };
		}

		// No session id yet: creation either never reached the provider or the
		// response was lost. The local reservation is the only safe statement.
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
			dodoEnvironment: v.optional(v.union(v.literal('test_mode'), v.literal('live_mode'))),
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
			dodoEnvironment: retained.dodoEnvironment
				? readDodoEnvironment({ DODO_PAYMENTS_ENVIRONMENT: retained.dodoEnvironment })
				: undefined,
			expiresAt: retained.expiresAt
		};
	}
});

/**
 * Wall-clock projection check for an attempt's tier/interval: true only when
 * the account's current subscription shows paid access on exactly that
 * selection. Used to report activation for a specific attempt.
 */
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
			if (!subscriptionIsActive(subscription, args.now)) continue;

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
		const customer = await ctx.runQuery(internal.billingCustomers.get, { userId });

		if (!customer) throw new Error('This account does not have a billing customer.');

		const portal = await ctx.runAction(internal.pricing.createCustomerPortal, {
			dodoCustomerId: customer.dodoCustomerId
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
			v.literal('duplicate'),
			v.literal('noop'),
			v.literal('competing'),
			v.literal('unresolved')
		),
		detail: v.optional(v.string())
	}),
	handler: async (ctx, args) => await applyDodoSubscriptionProjection(ctx, args)
});

type DodoSubscriptionEventArgs = {
	userId?: string;
	tier?: string;
	checkoutAttemptId?: string;
	dodoSubscriptionId: string;
	dodoProductId: string;
	dodoCustomerId: string;
	status:
		'active' | 'on_hold' | 'cancelled' | 'expired' | 'failed' | 'paused' | 'pending' | 'past_due';
	// Provider event time on webhooks; billing-period provenance on
	// reconciliation observations, which order on observedAt instead.
	eventAt: number;
	observedAt?: number;
	billingInterval: 'monthly' | 'annual';
	billingPeriodStart: number;
	billingPeriodEnd: number;
	cancelAtNextBillingDate: boolean;
	scheduledChange?: { id: string; productId: string; effectiveAt: number } | null;
};

export type ProjectionOutcome = {
	outcome: 'applied' | 'stale' | 'duplicate' | 'noop' | 'competing' | 'unresolved';
	detail?: string;
};

/**
 * The single subscription-projection path for signed webhooks and fenced
 * reconciliation observations. Pure reads and validation run before the first
 * write, so a rejected payload commits nothing and the caller's ledger outcome
 * stays atomic with the projection.
 */
export async function applyDodoSubscriptionProjection(
	ctx: MutationCtx,
	args: DodoSubscriptionEventArgs
): Promise<ProjectionOutcome> {
	if (!Number.isFinite(args.billingPeriodStart) || !Number.isFinite(args.billingPeriodEnd)) {
		throw new Error('Dodo billing period boundaries must be finite.');
	}

	if (args.billingPeriodEnd <= args.billingPeriodStart) {
		throw new Error('Dodo billing period must have a positive duration.');
	}

	const now = Date.now();

	// Provider pause is unsupported and must never grant access.
	if (args.status === 'paused' || args.status === 'pending') {
		return {
			outcome: 'unresolved' as const,
			detail: `Unsupported Dodo subscription status "${args.status}".`
		};
	}

	const knownCustomer = await ctx.db
		.query('billingCustomers')
		.withIndex('by_dodoCustomerId', (query) => query.eq('dodoCustomerId', args.dodoCustomerId))
		.unique();

	const userId = args.userId ?? knownCustomer?.userId;

	if (!userId) {
		return {
			outcome: 'unresolved' as const,
			detail: `Dodo subscription ${args.dodoSubscriptionId} has no mapped Sprocket user.`
		};
	}

	if (knownCustomer && knownCustomer.userId !== userId) {
		throw new Error('Dodo subscription customer does not match this account.');
	}

	const existing = await getSubscriptionDoc(ctx, userId);
	const sameIdentity = existing?.dodoSubscriptionId === args.dodoSubscriptionId;

	// Dodo's failed status is mandate-creation failure, not a failed upgrade
	// charge. A previously established identity needs provider repair instead.
	if (sameIdentity && args.status === 'failed' && existing.status !== 'failed') {
		await ctx.scheduler.runAfter(0, internal.subscriptionReconciliation.queueReconciliation, {
			subscriptionId: existing._id,
			dodoSubscriptionId: args.dodoSubscriptionId,
			projectionRevision: existing.projectionRevision ?? 0,
			force: true
		});

		return {
			outcome: 'unresolved',
			detail: 'Mandate failure conflicts with an established subscription.'
		};
	}

	// Operator-granted paid subscriptions without a Dodo id are never
	// overwritten by provider events.
	if (existing?.status === 'active' && existing.tier !== 'free' && !existing.dodoSubscriptionId) {
		return { outcome: 'competing' as const, detail: 'Operator-granted subscription preserved.' };
	}

	// Events for a superseded identity never reclaim the projection.
	if (existing?.dodoSubscriptionId !== args.dodoSubscriptionId) {
		const superseded = await ctx.db
			.query('supersededSubscriptions')
			.withIndex('by_dodoSubscriptionId', (query) =>
				query.eq('dodoSubscriptionId', args.dodoSubscriptionId)
			)
			.unique();

		if (superseded) {
			return {
				outcome: 'stale' as const,
				detail: `Superseded Dodo subscription ${args.dodoSubscriptionId}.`
			};
		}
	}

	const payload = {
		dodoSubscriptionId: args.dodoSubscriptionId,
		dodoProductId: args.dodoProductId,
		dodoCustomerId: args.dodoCustomerId,
		status: args.status,
		eventAt: args.eventAt,
		observedAt: args.observedAt,
		billingInterval: args.billingInterval,
		billingPeriodStart: args.billingPeriodStart,
		billingPeriodEnd: args.billingPeriodEnd,
		cancelAtNextBillingDate: args.cancelAtNextBillingDate,
		scheduledChange: args.scheduledChange ?? null
	};

	// past_due is the provider grace-period status; Sprocket keeps Dodo's
	// grace period off, so treat it like an on-hold renewal failure.
	const normalizedStatus = payload.status === 'past_due' ? 'on_hold' : payload.status;
	const isObservation = payload.observedAt !== undefined;

	// Status, product, term, and schedule fence independently; a payload stale
	// on all of them is a duplicate/older redelivery and changes nothing.
	const staleStatus = isStaleStatus({ existing, payload });
	const stalePayload = isStalePayload({ existing, payload });
	const staleTerm = isStaleTerm(existing, payload);
	const staleSchedule = isStaleSchedule({ existing, payload });

	if (staleStatus && stalePayload && staleTerm && staleSchedule) {
		return { outcome: 'stale' as const };
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
		(payload.observedAt ?? payload.eventAt) < payload.billingPeriodEnd
			? 'active'
			: normalizedStatus;

	const historicalFailure = normalizedTerminalOrHold(payload.status) && staleTerm;
	const keepStatus = staleStatus || historicalFailure;
	const effectiveStatus = keepStatus && existing ? existing.status : incomingStatus;

	if (
		sameIdentity &&
		!isObservation &&
		existing.observedAt !== undefined &&
		args.eventAt < existing.observedAt &&
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
		await ctx.scheduler.runAfter(0, internal.subscriptionReconciliation.queueReconciliation, {
			subscriptionId: existing._id,
			dodoSubscriptionId: args.dodoSubscriptionId,
			projectionRevision: existing.projectionRevision ?? 0,
			force: true
		});

		return {
			outcome: 'unresolved',
			detail: 'Delayed webhook conflicts with a provider observation; retrieval required.'
		};
	}

	if (identityTakeoverAllowed(existing, payload) === 'competing') {
		return {
			outcome: 'competing' as const,
			detail:
				`Conflicting Dodo subscription ${args.dodoSubscriptionId} while ` +
				`${existing?.dodoSubscriptionId} is not authoritatively terminal.`
		};
	}

	const customer = await ctx.db
		.query('billingCustomers')
		.withIndex('by_userId', (query) => query.eq('userId', userId))
		.unique();

	if (customer && customer.dodoCustomerId !== args.dodoCustomerId) {
		throw new Error('Dodo subscription customer does not match this account.');
	}

	const currentAttempt = args.checkoutAttemptId
		? await ctx.db
				.query('billingCheckoutSessions')
				.withIndex('by_userId_and_attemptId', (query) =>
					query.eq('userId', userId).eq('attemptId', args.checkoutAttemptId!)
				)
				.unique()
		: null;

	const retainedAttempt = args.checkoutAttemptId
		? await ctx.db
				.query('billingCheckoutAttempts')
				.withIndex('by_userId_and_attemptId', (query) =>
					query.eq('userId', userId).eq('attemptId', args.checkoutAttemptId!)
				)
				.unique()
		: null;

	const selectedAttempt = currentAttempt ?? retainedAttempt;

	const matchedAttempt = selectedAttempt?.productId === args.dodoProductId ? selectedAttempt : null;

	// Only the attempt this subscription actually paid through may be marked
	// paid; a different open reservation for the same account is untouched.
	const paidAttempt = matchedAttempt;

	if (matchedAttempt && matchedAttempt.interval !== args.billingInterval) {
		return {
			outcome: 'unresolved',
			detail: 'Subscription interval does not match the checkout attempt.'
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
		return { outcome: 'unresolved', detail: 'An established product changed billing interval.' };
	}

	// Old signed metadata tier is only authoritative while the product is
	// unchanged; a changed product resolves via attempt/mapping instead.
	const metadataTier = productUnchanged ? (args.tier ?? null) : null;

	const resolvedTier = resolveEffectiveTier({
		existing,
		payload,
		checkoutTier: matchedAttempt?.tierId ?? null,
		metadataTier,
		configuredTier:
			productUnchanged || matchedAttempt || stalePayload
				? null
				: await lookupTierForProduct(ctx, payload.dodoProductId, payload.billingInterval)
	});

	if (resolvedTier.unresolved && !stalePayload) {
		return { outcome: 'unresolved' as const, detail: resolvedTier.detail };
	}

	const tier =
		stalePayload && existing ? existing.tier : resolvedTier.unresolved ? 'free' : resolvedTier.tier;

	const sameSubscription =
		existing !== null && existing.dodoSubscriptionId === payload.dodoSubscriptionId;

	// Webhooks advance the term watermark with their own provider event time.
	// Observations never stamp it: their eventAt is billing-period provenance,
	// so a retrieval cannot fence out a delayed legitimate webhook.
	const termEventAt = isObservation
		? (existing?.termEventAt ?? existing?.eventAt ?? 0)
		: !staleTerm
			? Math.max(payload.eventAt, existing?.termEventAt ?? -Infinity)
			: (existing?.termEventAt ?? payload.eventAt);

	const previousTier = sameSubscription ? existing.tier : undefined;

	// Usage generation resets once per confirmed effective tier change or new
	// subscription. Renewals, status-only events, scheduled changes, and
	// unchanged-product remaps never mint a fresh generation.
	const isNewIdentity = !existing || !sameSubscription;

	const winsPayloadWatermark = !sameSubscription || !stalePayload;

	const isPlanChange = previousTier !== undefined && previousTier !== tier;

	// Released meters still key on quotaResetAt; the counter deduplicates transitions.
	const priorGeneration = existing?.quotaGeneration ?? existing?.quotaResetAt;
	const transitionAt = payload.observedAt ?? payload.eventAt;

	const resets =
		isNewIdentity || (isPlanChange && winsPayloadWatermark)
			? {
					generation: (priorGeneration ?? 0) + 1,
					transitionAt,
					resetAt: Math.max(transitionAt, (existing?.quotaResetAt ?? -Infinity) + 1)
				}
			: {
					generation: priorGeneration,
					transitionAt: existing?.quotaTransitionAt,
					resetAt: existing?.quotaResetAt
				};

	const terminalConfirmed =
		effectiveStatus === 'cancelled' || effectiveStatus === 'expired' || effectiveStatus === 'failed'
			? true
			: false;

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

	const access = computeAccess(
		{
			status: effectiveStatus,
			dodoSubscriptionId: payload.dodoSubscriptionId,
			billingPeriodStart: payload.billingPeriodStart,
			billingPeriodEnd: payload.billingPeriodEnd,
			cancelAtNextBillingDate: payload.cancelAtNextBillingDate
		},
		now
	);

	// Redelivery of an already-converged projection is a no-op; watermarks
	// advance only through the applied path.
	const matches =
		sameSubscription &&
		projectionMatches(existing, projected) &&
		existing.terminalConfirmed === terminalConfirmed;

	const statusEventAt = isObservation || keepStatus ? (existing?.eventAt ?? 0) : payload.eventAt;

	const productEventAt =
		isObservation || stalePayload
			? (existing?.payloadEventAt ?? existing?.eventAt ?? 0)
			: payload.eventAt;

	const scheduleEventAt =
		isObservation || staleSchedule
			? (existing?.scheduleEventAt ?? existing?.payloadEventAt ?? existing?.eventAt ?? 0)
			: payload.eventAt;

	if (
		matches &&
		statusEventAt === existing.eventAt &&
		productEventAt === existing.payloadEventAt &&
		termEventAt === existing.termEventAt &&
		scheduleEventAt === existing.scheduleEventAt
	) {
		if (payload.observedAt !== undefined)
			await ctx.db.patch('subscriptions', existing._id, { observedAt: payload.observedAt });

		return { outcome: 'noop' as const };
	}

	// --- First write below this point; every check above committed nothing. ---

	// A payable attempt that pays late (e.g. after a selection switch) still
	// resolves its outcome so status lookups converge. Unrelated attempts are
	// never marked paid by this subscription's confirmation.
	if (paidAttempt && paidAttempt.outcome !== 'paid' && effectiveStatus === 'active') {
		const current = currentAttempt;

		if (current) {
			await ctx.db.patch('billingCheckoutSessions', current._id, {
				outcome: 'paid',
				outcomeUpdatedAt: now,
				checkoutUrl: undefined,
				createRequest: undefined,
				idempotencyKey: undefined
			});
		} else {
			const retained = retainedAttempt;

			if (retained) {
				await ctx.db.patch('billingCheckoutAttempts', retained._id, {
					outcome: 'paid',
					outcomeUpdatedAt: now,
					checkoutUrl: undefined,
					createRequest: undefined,
					idempotencyKey: undefined
				});
			}
		}
	}

	if (!customer) {
		await ctx.db.insert('billingCustomers', { userId, dodoCustomerId: args.dodoCustomerId });
	}

	// Only a webhook-confirmed new identity supersedes; observations never do.
	if (
		existing?.dodoSubscriptionId &&
		existing.dodoSubscriptionId !== payload.dodoSubscriptionId &&
		!isObservation
	) {
		await ctx.db.insert('supersededSubscriptions', {
			userId,
			dodoSubscriptionId: existing.dodoSubscriptionId,
			supersededAt: now
		});
	}

	const revision = (existing?.projectionRevision ?? 0) + 1;

	// Watermarks hold webhook provider event times only; observations never
	// stamp them, so a delayed legitimate webhook is never fenced out.
	const subscription = {
		userId,
		tier,
		status: effectiveStatus,
		eventAt: statusEventAt,
		providerStatus: keepStatus ? (existing?.providerStatus ?? existing?.status) : args.status,
		payloadEventAt: productEventAt,
		scheduleEventAt,
		termEventAt,
		projectionRevision: revision,
		observedAt: payload.observedAt ?? existing?.observedAt,
		checkoutAttemptId:
			matchedAttempt?.attemptId ?? (sameSubscription ? existing.checkoutAttemptId : undefined),
		accessPhase: access.accessPhase,
		accessEndsAt: access.accessEndsAt,
		scheduledChange: payload.scheduledChange ?? undefined,
		billingInterval: payload.billingInterval,
		billingPeriodStart: payload.billingPeriodStart,
		billingPeriodEnd: payload.billingPeriodEnd,
		billingPeriodEnded: false,
		billingPeriodCheckId: existing?.billingPeriodCheckId,
		cancelAtNextBillingDate: payload.cancelAtNextBillingDate,
		quotaGeneration: resets.generation ?? existing?.quotaGeneration,
		quotaTransitionAt: resets.transitionAt ?? existing?.quotaTransitionAt,
		// Released readers key buckets here; equal-time changes advance it by 1ms.
		quotaResetAt: resets.resetAt,
		terminalConfirmed,
		dodoSubscriptionId: payload.dodoSubscriptionId,
		dodoProductId: payload.dodoProductId
	};

	const subscriptionId = existing?._id ?? (await ctx.db.insert('subscriptions', subscription));

	if (existing) await ctx.db.replace('subscriptions', subscriptionId, subscription);

	await scheduleSubscriptionExpiry(ctx, { _id: subscriptionId, ...subscription });

	if (
		!isObservation &&
		access.accessPhase === 'none' &&
		!terminalConfirmed &&
		(!sameSubscription || existing.accessPhase !== 'none' || existing.status !== effectiveStatus)
	) {
		await ctx.scheduler.runAfter(0, internal.subscriptionReconciliation.queueReconciliation, {
			subscriptionId,
			dodoSubscriptionId: payload.dodoSubscriptionId,
			projectionRevision: revision
		});
	}

	return { outcome: matches ? ('noop' as const) : ('applied' as const) };
}
