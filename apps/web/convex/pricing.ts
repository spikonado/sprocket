'use node';

import DodoPayments from 'dodopayments';
import { Webhook } from 'standardwebhooks';
import { v } from 'convex/values';
import { z } from 'zod';
import { internal } from '@convex/_generated/api';
import { action, env, internalAction } from '@convex/_generated/server';
import {
	matchesBillingInterval,
	readDodoEnvironment,
	type BillingInterval,
	type DodoPublicPrice
} from '@convex/lib/dodoProducts';
import {
	vPublicPricingCatalog,
	type PublicPricingCatalog,
	type PublicPricingPlan,
	type TierPricingConfig
} from '@convex/lib/pricingValidators';
import { vBillingInterval } from '@convex/lib/validators';

const DODO_PRICE_CACHE_TTL_MS = 5 * 60 * 1_000;

// Negative cache for definitively invalid/missing/ambiguous products.
const DODO_PRICE_NEGATIVE_TTL_MS = 30 * 60 * 1_000;

// Stale display bound: past fresh expiry, a cached price may display for at
// most this long while refreshes fail; older rows are hidden until refreshed.
const DODO_PRICE_STALE_MAX_MS = 30 * 60 * 1_000;

// Transient failures retry quickly but stay off the hot path.
const DODO_PRICE_TRANSIENT_RETRY_MS = 30 * 1_000;

const DODO_PRICE_LEASE_MS = 30 * 1_000;

// Bounded fan-out for cold-cache refreshes: at most this many concurrent
// product retrievals, each with an explicit timeout, and a hard cap on how
// many products one catalog request will refresh. The fetch budget stays at
// or below the durable global lease budget so one operation can never
// over-claim the environment-wide fetch allowance; the smallest cap wins.
const DODO_FETCH_CONCURRENCY = 4;

const DODO_FETCH_TIMEOUT_MS = 8 * 1_000;

const DODO_FETCH_BUDGET_PER_OPERATION = 8;

function publicPlanFromConfig(
	plan: TierPricingConfig,
	prices: PublicPricingPlan['prices']
): PublicPricingPlan {
	return {
		id: plan.id,
		label: plan.label,
		weeklyUsageDollars: plan.weeklyUsageDollars,
		monthlyUsageDollars: plan.monthlyUsageDollars,
		description: plan.description,
		features: plan.features,
		displayOrder: plan.displayOrder,
		highlighted: plan.highlighted,
		prices
	};
}

function createDodoClient(): DodoPayments {
	return new DodoPayments({
		bearerToken: env.DODO_PAYMENTS_API_KEY,
		environment: readDodoEnvironment(env),
		timeout: DODO_FETCH_TIMEOUT_MS,
		maxRetries: 0
	});
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} timed out.`)), ms);

		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
}

async function retrieveRecurringPrice(
	client: DodoPayments,
	productId: string,
	interval: BillingInterval
) {
	const product = await withTimeout(
		client.products.retrieve(productId),
		DODO_FETCH_TIMEOUT_MS,
		`Dodo product ${productId} lookup`
	);

	if (product.price.type !== 'recurring_price') {
		throw new Error(`Dodo product ${productId} is not a recurring subscription.`);
	}

	if (
		!matchesBillingInterval(
			interval,
			product.price.payment_frequency_count,
			product.price.payment_frequency_interval
		)
	) {
		throw new Error(`Dodo product ${productId} does not match the ${interval} billing interval.`);
	}

	if (product.price.price <= 0)
		throw new Error(`Dodo product ${productId} does not have a paid price.`);

	return {
		productId: product.product_id,
		name: product.name ?? null,
		amountMinor: product.price.price,
		currency: product.price.currency,
		paymentFrequencyCount: product.price.payment_frequency_count,
		paymentFrequencyInterval: product.price.payment_frequency_interval
	};
}

export const ensureCustomer = internalAction({
	args: { userId: v.string(), email: v.optional(v.string()), name: v.string() },
	returns: v.string(),
	handler: async (ctx, { userId, email, name }): Promise<string> => {
		const environment = readDodoEnvironment(env);
		const existing = await ctx.runQuery(internal.billingCustomers.get, { userId });

		if (existing) {
			if (existing.dodoEnvironment && existing.dodoEnvironment !== environment) {
				throw new Error(
					'This account has a billing customer from a different environment. Contact support.'
				);
			}

			return existing.dodoCustomerId;
		}

		if (!email?.trim()) throw new Error('Your account does not have a billing email.');

		const customer = await createDodoClient().customers.create(
			{ email: email.trim(), name, metadata: { userId } },
			{ headers: { 'Idempotency-Key': `sprocket-customer:${userId}` } }
		);

		return await ctx.runMutation(internal.billingCustomers.remember, {
			userId,
			dodoCustomerId: customer.customer_id,
			dodoEnvironment: environment
		});
	}
});

export const createCheckoutSession = internalAction({
	args: {
		attemptId: v.string(),
		userId: v.string(),
		tierId: v.string(),
		productId: v.string(),
		interval: vBillingInterval,
		returnUrl: v.string(),
		cancelUrl: v.string(),
		dodoCustomerId: v.string(),
		idempotencyKey: v.optional(v.string())
	},
	returns: v.object({ checkoutUrl: v.union(v.string(), v.null()), sessionId: v.string() }),
	handler: async (_ctx, args) => {
		const client = createDodoClient();
		await retrieveRecurringPrice(client, args.productId, args.interval);

		const session = await client.checkoutSessions.create(
			{
				product_cart: [{ product_id: args.productId, quantity: 1 }],
				metadata: {
					userId: args.userId,
					tierId: args.tierId,
					checkoutAttemptId: args.attemptId
				},
				return_url: args.returnUrl,
				cancel_url: args.cancelUrl,
				feature_flags: {
					allow_discount_code: true,
					allow_customer_editing_email: false,
					always_create_new_customer: false
				},
				customer: { customer_id: args.dodoCustomerId }
			},
			{ headers: { 'Idempotency-Key': args.idempotencyKey ?? args.attemptId } }
		);

		return { checkoutUrl: session.checkout_url ?? null, sessionId: session.session_id };
	}
});

export type RecoveredCheckoutStatus = 'awaiting_payment' | 'pending' | 'succeeded' | 'failed';

/**
 * Provider-backed lookup for a checkout session. Dodo has no session-cancel
 * API and no session-expiry readback; status derives from the payment intent
 * behind the session, so no payment id yet means details are still being
 * collected.
 */
export const recoverCheckoutSession = internalAction({
	args: { sessionId: v.string() },
	returns: v.object({
		status: v.union(
			v.literal('awaiting_payment'),
			v.literal('pending'),
			v.literal('succeeded'),
			v.literal('failed')
		),
		checkoutUrl: v.union(v.string(), v.null())
	}),
	handler: async (
		_ctx,
		{ sessionId }
	): Promise<{
		status: RecoveredCheckoutStatus;
		checkoutUrl: string | null;
	}> => {
		const client = createDodoClient();
		const session = await client.checkoutSessions.retrieve(sessionId);

		if (!session.payment_id) {
			return { status: 'awaiting_payment', checkoutUrl: null };
		}

		switch (session.payment_status) {
			case 'succeeded':
				return { status: 'succeeded', checkoutUrl: null };
			case 'failed':
			case 'cancelled':
				return { status: 'failed', checkoutUrl: null };
			case null:
			case undefined:
				return { status: 'awaiting_payment', checkoutUrl: null };
			default:
				return { status: 'pending', checkoutUrl: null };
		}
	}
});

export const createCustomerPortal = internalAction({
	args: { dodoCustomerId: v.string() },
	returns: v.object({ portal_url: v.string() }),
	handler: async (_ctx, { dodoCustomerId }) => {
		const session = await createDodoClient().customers.customerPortal.create(dodoCustomerId, {
			send_email: false
		});

		if (!session.link) throw new Error('Customer portal did not return a URL.');

		return { portal_url: session.link };
	}
});

export const getPublicCatalog = action({
	args: {},
	returns: vPublicPricingCatalog,
	handler: async (ctx): Promise<PublicPricingCatalog> => {
		const tierConfigs: TierPricingConfig[] = await ctx.runQuery(
			internal.pricingData.getPublicPlans,
			{}
		);

		const emptyPlans = tierConfigs.map((plan) =>
			publicPlanFromConfig(plan, { monthly: null, annual: null })
		);

		const configuredProducts = tierConfigs.flatMap((plan) =>
			(['monthly', 'annual'] as const).flatMap((interval) => {
				const productId = interval === 'monthly' ? plan.monthlyProductId : plan.annualProductId;

				return productId ? [{ tierId: plan.id, interval, productId }] : [];
			})
		);

		const productOwners = new Map<string, { tierId: string; interval: BillingInterval }>();
		const ambiguousProducts = new Set<string>();

		for (const product of configuredProducts) {
			const owner = productOwners.get(product.productId);

			if (owner) {
				ambiguousProducts.add(product.productId);
				console.error(
					`Dodo product "${product.productId}" is assigned to both ${owner.tierId} ${owner.interval} and ${product.tierId} ${product.interval}.`
				);
			}

			productOwners.set(product.productId, product);
		}

		if (configuredProducts.length === 0 || !env.DODO_PAYMENTS_API_KEY?.trim()) {
			return { plans: emptyPlans };
		}

		const environment = readDodoEnvironment(env);
		const now = Date.now();

		const cacheKey = `${environment}:${configuredProducts
			.map(({ tierId, interval, productId }) => `${tierId}:${interval}:${productId}`)
			.sort()
			.join('|')}`;

		const cachedRows: Array<{
			productId: string | null;
			price: DodoPublicPrice | null;
			expiresAt: number;
			refreshFailed: boolean;
			retryAt: number | null;
			validatedAt: number | null;
			leaseActive: boolean;
		}> = await ctx.runQuery(internal.pricingData.getProductPricesForEnvironment, {
			environment,
			cacheKey,
			productIds: configuredProducts.map((product) => product.productId),
			now
		});

		const intervalFor = new Map(
			configuredProducts.map((product) => [product.productId, product.interval])
		);

		const priceByProduct = new Map<string, DodoPublicPrice>();

		for (const row of cachedRows) {
			if (!row.productId || !row.price) continue;

			// Bounded staleness: display is allowed from the last provider
			// confirmation only, never extended by retry deadlines. Rows without
			// a confirmation time (legacy aggregate rows) fall back to their
			// expiry as the confirmation bound.
			const confirmedAt = row.validatedAt ?? row.expiresAt;

			if (confirmedAt + DODO_PRICE_STALE_MAX_MS <= now) continue;

			// Validate cached prices against the current mapping: a remapped or
			// ambiguous product must not misattribute a stale price.
			if (
				ambiguousProducts.has(row.productId) ||
				!matchesBillingInterval(
					intervalFor.get(row.productId) ?? 'monthly',
					row.price.paymentFrequencyCount,
					row.price.paymentFrequencyInterval
				)
			) {
				continue;
			}

			priceByProduct.set(row.productId, row.price);
		}

		const needsRefresh = new Set<string>();

		for (const { productId } of configuredProducts) {
			if (ambiguousProducts.has(productId)) continue;

			const rows = cachedRows.filter((row) => row.productId === productId);
			const fresh = rows.some((row) => row.expiresAt > now && !row.refreshFailed);
			const leased = rows.some((row) => row.leaseActive);

			if (!fresh && !leased) needsRefresh.add(productId);
		}

		if (needsRefresh.size > 0) {
			const leaseOwner = crypto.randomUUID();
			const queue = [...needsRefresh].slice(0, DODO_FETCH_BUDGET_PER_OPERATION);
			const client = createDodoClient();

			// Fixed worker pool: each worker pops the queue and claims its lease
			// immediately before fetching, so queued products never hold leases
			// (or count against the durable global budget) while they wait. The
			// queue cap bounds both claim attempts and fetches per operation.
			const workers = Array.from(
				{ length: Math.min(DODO_FETCH_CONCURRENCY, queue.length) },
				async () => {
					let productId: string | undefined;

					while ((productId = queue.pop()) !== undefined) {
						const interval = intervalFor.get(productId);

						if (!interval) continue;

						const acquired = await ctx.runMutation(
							internal.pricingData.acquireProductRefreshLease,
							{
								environment,
								productId,
								leaseOwner,
								leaseExpiresAt: Date.now() + DODO_PRICE_LEASE_MS,
								now: Date.now()
							}
						);

						if (!acquired) continue;

						try {
							const price = await retrieveRecurringPrice(client, productId, interval);
							const refreshedAt = Date.now();

							await ctx.runMutation(internal.pricingData.cacheProductPrice, {
								environment,
								productId,
								price,
								refreshFailed: false,
								expiresAt: refreshedAt + DODO_PRICE_CACHE_TTL_MS,
								leaseOwner,
								now: refreshedAt
							});

							priceByProduct.set(productId, price);
						} catch (error) {
							const definitive =
								error instanceof Error &&
								/Dodo product .*(recurring subscription|billing interval|paid price)/.test(
									error.message
								);

							const failedAt = Date.now();

							console.error(`Could not load Dodo product ${productId}.`);

							await ctx.runMutation(internal.pricingData.cacheProductPrice, {
								environment,
								productId,
								price: null,
								refreshFailed: true,
								retryAt: definitive ? null : failedAt + DODO_PRICE_TRANSIENT_RETRY_MS,
								expiresAt:
									failedAt +
									(definitive ? DODO_PRICE_NEGATIVE_TTL_MS : DODO_PRICE_TRANSIENT_RETRY_MS),
								leaseOwner,
								now: failedAt
							});
						}
					}
				}
			);

			await Promise.all(workers);
		}

		const plans = tierConfigs.map((plan) =>
			publicPlanFromConfig(plan, {
				monthly: plan.monthlyProductId ? (priceByProduct.get(plan.monthlyProductId) ?? null) : null,
				annual: plan.annualProductId ? (priceByProduct.get(plan.annualProductId) ?? null) : null
			})
		);

		return { plans };
	}
});

/**
 * Authoritative subscription lookup for reconciliation. Returns the raw
 * provider state needed to rebuild the local projection; callers treat this
 * as an observation, not a synthetic event.
 */
export const retrieveSubscription = internalAction({
	args: { dodoSubscriptionId: v.string() },
	returns: v.object({
		subscriptionId: v.string(),
		productId: v.string(),
		status: v.string(),
		previousBillingDate: v.string(),
		nextBillingDate: v.string(),
		cancelAtNextBillingDate: v.boolean(),
		paymentFrequencyCount: v.number(),
		paymentFrequencyInterval: v.string(),
		customerId: v.string(),
		metadata: v.record(v.string(), v.string()),
		scheduledChange: v.union(
			v.object({ id: v.string(), productId: v.string(), effectiveAt: v.string() }),
			v.null()
		)
	}),
	handler: async (_ctx, { dodoSubscriptionId }) => {
		const client = createDodoClient();

		const subscription = await withTimeout(
			client.subscriptions.retrieve(dodoSubscriptionId),
			DODO_FETCH_TIMEOUT_MS,
			`Dodo subscription ${dodoSubscriptionId} lookup`
		);

		const scheduled = subscription.scheduled_change;

		return {
			subscriptionId: subscription.subscription_id,
			productId: subscription.product_id,
			status: subscription.status,
			previousBillingDate: subscription.previous_billing_date,
			nextBillingDate: subscription.next_billing_date,
			cancelAtNextBillingDate: subscription.cancel_at_next_billing_date,
			paymentFrequencyCount: subscription.payment_frequency_count,
			paymentFrequencyInterval: subscription.payment_frequency_interval,
			customerId: subscription.customer.customer_id,
			metadata: z.record(z.string(), z.string()).parse(subscription.metadata),
			scheduledChange: scheduled
				? { id: scheduled.id, productId: scheduled.product_id, effectiveAt: scheduled.effective_at }
				: null
		};
	}
});

const webhookSecret = (): string => {
	const secret = env.DODO_PAYMENTS_WEBHOOK_SECRET;

	if (!secret?.trim()) throw new Error('DODO_PAYMENTS_WEBHOOK_SECRET is not configured.');

	return secret.trim();
};

/**
 * Verify a Dodo webhook's Standard Webhooks signature over the raw request
 * body and return the event identity used for the durable ledger. Throws on
 * invalid signatures or an out-of-tolerance timestamp. Uses the maintained
 * `standardwebhooks` verifier directly rather than the SDK's rigid typed
 * event unwrap so unknown event types stay durable. Must run in node.
 */
export const verifyWebhookSignature = internalAction({
	args: {
		body: v.string(),
		webhookId: v.string(),
		webhookSignature: v.string(),
		webhookTimestamp: v.string()
	},
	returns: v.object({
		eventType: v.string(),
		eventAt: v.optional(v.number()),
		subscriptionId: v.optional(v.string()),
		productId: v.optional(v.string()),
		customerId: v.optional(v.string())
	}),
	handler: async (_ctx, args) => {
		const verifier = new Webhook(webhookSecret());

		// Throws WebhookVerificationError on a bad signature or a timestamp
		// outside the tolerance window; the raw body is verified verbatim.
		verifier.verify(args.body, {
			'webhook-id': args.webhookId,
			'webhook-signature': args.webhookSignature,
			'webhook-timestamp': args.webhookTimestamp
		});

		const envelope = z
			.object({
				type: z.string().min(1),
				timestamp: z.string().optional(),
				data: z
					.object({
						subscription_id: z.string().optional(),
						product_id: z.string().optional(),
						customer: z.object({ customer_id: z.string().optional() }).optional()
					})
					.optional()
			})
			.parse(JSON.parse(args.body));

		const eventAt = envelope.timestamp ? Date.parse(envelope.timestamp) : Number.NaN;

		return {
			eventType: envelope.type,
			eventAt: Number.isFinite(eventAt) ? eventAt : undefined,
			subscriptionId: envelope.data?.subscription_id,
			productId: envelope.data?.product_id,
			customerId: envelope.data?.customer?.customer_id
		};
	}
});
