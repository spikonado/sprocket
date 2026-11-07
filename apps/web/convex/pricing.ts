'use node';

import DodoPayments from 'dodopayments';
import type { SubscriptionStatus } from 'dodopayments/resources';
import { Webhook, WebhookVerificationError } from 'standardwebhooks';
import { v } from 'convex/values';
import { z } from 'zod';
import { internal } from '@convex/_generated/api';
import { action, env, internalAction } from '@convex/_generated/server';
import {
	dodoWebhookEnvelopeSchema,
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
import { vBillingInterval, vDodoWebhookRejected } from '@convex/lib/validators';

const DODO_PRICE_CACHE_TTL_MS = 5 * 60 * 1_000;

const DODO_PRICE_NEGATIVE_TTL_MS = 30 * 60 * 1_000;

const DODO_PRICE_STALE_MAX_MS = 30 * 60 * 1_000;

export const DODO_PRICE_TRANSIENT_RETRY_MS = 30 * 1_000;

const DODO_PRICE_LEASE_MS = 30 * 1_000;

// Bounded fan-out for cold-cache refreshes: at most this many concurrent
// product retrievals, each with an explicit timeout, and a hard cap on how
// many products one catalog request will refresh. The fetch budget stays at
// or below the durable global lease budget so one operation can never
// over-claim the environment-wide fetch allowance; the smallest cap wins.
export const DODO_FETCH_CONCURRENCY = 4;

const DODO_FETCH_TIMEOUT_MS = 8 * 1_000;

export const DODO_FETCH_BUDGET_PER_OPERATION = 8;

function publicPlanFromConfig(
	plan: TierPricingConfig,
	prices: PublicPricingPlan['prices']
): PublicPricingPlan {
	return {
		id: plan.id,
		label: plan.label,
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
		const existing = await ctx.runQuery(internal.billingCustomers.getDodoCustomerId, { userId });

		if (existing) return existing;

		if (!email?.trim()) throw new Error('Your account does not have a billing email.');

		const customer = await createDodoClient().customers.create(
			{ email: email.trim(), name, metadata: { userId } },
			{ headers: { 'Idempotency-Key': `sprocket-customer:${userId}` } }
		);

		return await ctx.runMutation(internal.billingCustomers.remember, {
			userId,
			dodoCustomerId: customer.customer_id
		});
	}
});

export const validateCheckoutProduct = internalAction({
	args: { productId: v.string(), interval: vBillingInterval },
	returns: v.null(),
	handler: async (_ctx, args) => {
		await retrieveRecurringPrice(createDodoClient(), args.productId, args.interval);

		return null;
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

const LIVE_SUBSCRIPTION_STATUSES: ReadonlySet<SubscriptionStatus> = new Set([
	'active',
	'on_hold',
	'past_due',
	'paused',
	'pending'
]);

// A customer holds a handful of subscriptions, so one page is enough.
export const hasLiveSubscription = internalAction({
	args: { dodoCustomerId: v.string() },
	returns: v.boolean(),
	handler: async (_ctx, { dodoCustomerId }) => {
		const page = await createDodoClient().subscriptions.list({
			customer_id: dodoCustomerId,
			page_size: 100
		});

		return page.items.some((subscription) => LIVE_SUBSCRIPTION_STATUSES.has(subscription.status));
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

		const cachedRows: Array<{
			productId: string;
			price: DodoPublicPrice | null;
			expiresAt: number;
			refreshFailed: boolean;
			retryAt: number | null;
			validatedAt: number | null;
			leaseActive: boolean;
		}> = await ctx.runQuery(internal.pricingData.getProductPricesForEnvironment, {
			environment,
			productIds: configuredProducts.map((product) => product.productId),
			now
		});

		const intervalFor = new Map(
			configuredProducts.map((product) => [product.productId, product.interval])
		);

		const priceByProduct = new Map<string, DodoPublicPrice>();

		for (const row of cachedRows) {
			if (!row.price || row.validatedAt === null) continue;

			// Bounded staleness: display is allowed from the last provider
			// confirmation only, never extended by retry deadlines.
			if (row.validatedAt + DODO_PRICE_STALE_MAX_MS <= now) continue;

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

export const verifyWebhookSignature = internalAction({
	args: {
		body: v.string(),
		webhookId: v.string(),
		webhookSignature: v.string(),
		webhookTimestamp: v.string()
	},
	returns: v.union(
		v.object({
			kind: v.literal('verified'),
			eventType: v.string(),
			eventAt: v.optional(v.number()),
			subscriptionId: v.optional(v.string()),
			productId: v.optional(v.string()),
			customerId: v.optional(v.string())
		}),
		vDodoWebhookRejected
	),
	handler: async (_ctx, args) => {
		const verifier = new Webhook(webhookSecret());
		let payload: unknown;

		try {
			payload = verifier.verify(args.body, {
				'webhook-id': args.webhookId,
				'webhook-signature': args.webhookSignature,
				'webhook-timestamp': args.webhookTimestamp
			});
		} catch (error) {
			if (error instanceof WebhookVerificationError) {
				return { kind: 'rejected' as const, reason: 'signature' as const };
			}

			// `verify` JSON-parses the body once the signature matches.
			if (error instanceof SyntaxError) {
				return { kind: 'rejected' as const, reason: 'payload' as const };
			}

			throw error;
		}

		const envelope = dodoWebhookEnvelopeSchema
			.extend({
				data: z
					.object({
						subscription_id: z.string().optional(),
						product_id: z.string().optional(),
						customer: z.object({ customer_id: z.string().optional() }).optional()
					})
					.optional()
			})
			.safeParse(payload);

		if (!envelope.success) return { kind: 'rejected' as const, reason: 'payload' as const };

		const { type, timestamp, data } = envelope.data;
		const eventAt = timestamp ? Date.parse(timestamp) : Number.NaN;

		return {
			kind: 'verified' as const,
			eventType: type,
			eventAt: Number.isFinite(eventAt) ? eventAt : undefined,
			subscriptionId: data?.subscription_id,
			productId: data?.product_id,
			customerId: data?.customer?.customer_id
		};
	}
});
