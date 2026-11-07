'use node';

import DodoPayments from 'dodopayments';
import type {
	CheckoutSessionStatus,
	Subscription,
	SubscriptionListResponse,
	SubscriptionStatus
} from 'dodopayments/resources';
import { ConvexError, v, type Infer } from 'convex/values';
import { z } from 'zod';
import { internal } from '@convex/_generated/api';
import { env, internalAction, type ActionCtx } from '@convex/_generated/server';
import {
	matchesBillingInterval,
	readDodoEnvironment,
	type BillingInterval
} from '@convex/lib/dodoProducts';
import { vCreditPackTerms, type PackPrice, type Price } from '@convex/lib/pricingValidators';
import { vCheckoutAttemptStatus } from '@convex/lib/validators';

export const LIVE_SUBSCRIPTION_CHECKOUT_ERROR =
	'You already have a subscription. Use "Manage billing" to change it.';

const LIVE_SUBSCRIPTION_STATUSES: ReadonlySet<SubscriptionStatus> = new Set([
	'active',
	'on_hold',
	'past_due',
	'paused',
	'pending'
]);

const subscriptionEventData = z.object({ subscription_id: z.string() });

const paymentEventData = z.object({ payment_id: z.string() });

const dodoPayment = z.object({
	payment_id: z.string(),
	status: z.string().nullish(),
	created_at: z.string(),
	customer: z.object({ customer_id: z.string() }),
	metadata: z.record(z.string(), z.unknown()),
	product_cart: z.array(z.object({ product_id: z.string(), quantity: z.number() })).nullish(),
	refunds: z.array(z.object({ status: z.string() })),
	disputes: z.array(z.unknown())
});

/** Set by `createCheckout`; a pack checkout also records the pack's terms at purchase time. */
const checkoutMetadata = z.object({
	userId: z.string().optional(),
	creditUnits: z.coerce.number().optional(),
	creditExpiresAfterCount: z.coerce.number().optional(),
	creditExpiresAfterUnit: z.enum(['day', 'month', 'year']).optional()
});

function createDodoClient(): DodoPayments {
	return new DodoPayments({
		bearerToken: env.DODO_PAYMENTS_API_KEY,
		environment: readDodoEnvironment(env),
		timeout: 8_000
	});
}

function toEpochMs(timestamp: string): number {
	const ms = Date.parse(timestamp);

	if (!Number.isFinite(ms)) throw new Error(`Dodo returned an invalid date "${timestamp}".`);

	return ms;
}

async function mirror(
	ctx: ActionCtx,
	subscription: Subscription | SubscriptionListResponse,
	fetchedAt: number
): Promise<void> {
	await ctx.runMutation(internal.subscriptions.sync, {
		fetchedAt,
		metadataUserId: checkoutMetadata.parse(subscription.metadata).userId,
		dodoCustomerId: subscription.customer.customer_id,
		subscription: {
			dodoSubscriptionId: subscription.subscription_id,
			dodoProductId: subscription.product_id,
			status: subscription.status,
			billingPeriodStart: toEpochMs(subscription.previous_billing_date),
			billingPeriodEnd: toEpochMs(subscription.next_billing_date),
			cancelAtNextBillingDate: subscription.cancel_at_next_billing_date
		}
	});
}

async function syncSubscription(
	ctx: ActionCtx,
	client: DodoPayments,
	dodoSubscriptionId: string
): Promise<void> {
	const fetchedAt = Date.now();
	await mirror(ctx, await client.subscriptions.retrieve(dodoSubscriptionId), fetchedAt);
}

/** One page covers a customer; checkout refuses a second live subscription. */
async function listCustomerSubscriptions(client: DodoPayments, dodoCustomerId: string) {
	const page = await client.subscriptions.list({ customer_id: dodoCustomerId, page_size: 100 });

	return page.items;
}

/**
 * Payment events carry the payment; refund and dispute events name it, so fetch it.
 * Any succeeded refund or any dispute revokes the pack, including a dispute later won.
 * Payments without pack terms in their metadata, such as subscription charges, are skipped.
 */
async function syncPayment(
	ctx: ActionCtx,
	client: DodoPayments,
	event: { type: string; data: unknown }
): Promise<void> {
	const payment = dodoPayment.parse(
		event.type.startsWith('payment.')
			? event.data
			: await client.payments.retrieve(paymentEventData.parse(event.data).payment_id)
	);

	const [item] = payment.product_cart ?? [];

	const {
		userId,
		creditUnits,
		creditExpiresAfterCount: count,
		creditExpiresAfterUnit: unit
	} = checkoutMetadata.parse(payment.metadata);

	if (!item || creditUnits === undefined || count === undefined || unit === undefined) return;

	await ctx.runMutation(internal.credits.syncPayment, {
		paymentId: payment.payment_id,
		succeeded: payment.status === 'succeeded',
		revoked:
			event.type === 'refund.succeeded' ||
			event.type.startsWith('dispute.') ||
			payment.disputes.length > 0 ||
			payment.refunds.some(({ status }) => status === 'succeeded'),
		paidAt: toEpochMs(payment.created_at),
		dodoCustomerId: payment.customer.customer_id,
		metadataUserId: userId,
		productId: item.product_id,
		units: creditUnits,
		expiresAfter: { count, unit }
	});
}

/** Throws on anything retryable so the HTTP route answers 500 and Dodo redelivers. */
export const handleWebhook = internalAction({
	args: { body: v.string(), headers: v.record(v.string(), v.string()) },
	returns: v.union(v.literal('handled'), v.literal('invalid')),
	handler: async (ctx, { body, headers }) => {
		const key = env.DODO_PAYMENTS_WEBHOOK_SECRET?.trim();

		if (!key) throw new Error('DODO_PAYMENTS_WEBHOOK_SECRET is not configured.');
		const client = createDodoClient();
		let event;

		try {
			event = client.webhooks.unwrap(body, { headers, key });
		} catch {
			return 'invalid';
		}

		if (event.type.startsWith('subscription.')) {
			await syncSubscription(ctx, client, subscriptionEventData.parse(event.data).subscription_id);
		} else if (/^(payment|refund|dispute)\./.test(event.type)) {
			await syncPayment(ctx, client, event);
		}

		return 'handled';
	}
});

export const syncCustomer = internalAction({
	args: { dodoCustomerId: v.string() },
	returns: v.null(),
	handler: async (ctx, { dodoCustomerId }) => {
		const fetchedAt = Date.now();
		const subscriptions = await listCustomerSubscriptions(createDodoClient(), dodoCustomerId);

		for (const subscription of subscriptions) await mirror(ctx, subscription, fetchedAt);

		return null;
	}
});

/** Catches renewals and cancellations whose webhooks never arrived. */
export const syncOverdue = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const ids = await ctx.runQuery(internal.subscriptions.listOverdue, { now: Date.now() });
		const client = createDodoClient();

		for (const id of ids) {
			try {
				await syncSubscription(ctx, client, id);
			} catch (error) {
				console.error(`Could not sync Dodo subscription ${id}.`, error);
			}
		}

		return null;
	}
});

async function ensureCustomer(
	ctx: ActionCtx,
	client: DodoPayments,
	{ userId, email, name }: { userId: string; email?: string; name: string }
): Promise<{ dodoCustomerId: string; created: boolean }> {
	const existing = await ctx.runQuery(internal.billingCustomers.getDodoCustomerId, { userId });

	if (existing) return { dodoCustomerId: existing, created: false };

	if (!email?.trim()) throw new ConvexError('Your account does not have a billing email.');

	const customer = await client.customers.create(
		{ email: email.trim(), name, metadata: { userId } },
		{ headers: { 'Idempotency-Key': `sprocket-customer:${userId}` } }
	);

	const dodoCustomerId = await ctx.runMutation(internal.billingCustomers.remember, {
		userId,
		dodoCustomerId: customer.customer_id
	});

	return { dodoCustomerId, created: true };
}

export const createCheckout = internalAction({
	args: {
		userId: v.string(),
		email: v.optional(v.string()),
		name: v.string(),
		productId: v.string(),
		// Present for a pack; subscriptions refuse a second live subscription instead.
		creditPack: v.optional(vCreditPackTerms),
		returnUrl: v.string(),
		cancelUrl: v.string()
	},
	returns: v.object({ sessionId: v.string(), checkoutUrl: v.string() }),
	handler: async (ctx, args) => {
		const client = createDodoClient();
		const customer = await ensureCustomer(ctx, client, args);

		if (!args.creditPack && !customer.created) {
			const subscriptions = await listCustomerSubscriptions(client, customer.dodoCustomerId);

			if (subscriptions.some(({ status }) => LIVE_SUBSCRIPTION_STATUSES.has(status))) {
				throw new ConvexError(LIVE_SUBSCRIPTION_CHECKOUT_ERROR);
			}
		}

		const session = await client.checkoutSessions.create({
			product_cart: [{ product_id: args.productId, quantity: 1 }],
			metadata: {
				userId: args.userId,
				...(args.creditPack && {
					creditUnits: String(args.creditPack.units),
					creditExpiresAfterCount: String(args.creditPack.expiresAfter.count),
					creditExpiresAfterUnit: args.creditPack.expiresAfter.unit
				})
			},
			return_url: args.returnUrl,
			cancel_url: args.cancelUrl,
			feature_flags: {
				single_page: true,
				allow_discount_code: true,
				allow_customer_editing_email: false,
				always_create_new_customer: false
			},
			customer: { customer_id: customer.dodoCustomerId }
		});

		if (!session.checkout_url) throw new Error('Dodo did not return a checkout URL.');

		return { sessionId: session.session_id, checkoutUrl: session.checkout_url };
	}
});

function checkoutStatus({
	payment_id,
	payment_status
}: CheckoutSessionStatus): Infer<typeof vCheckoutAttemptStatus> {
	if (!payment_id || !payment_status) return 'awaiting_payment';

	if (payment_status === 'succeeded') return 'succeeded';

	if (payment_status === 'failed' || payment_status === 'cancelled') return 'failed';

	return 'pending';
}

export const getCheckoutStatus = internalAction({
	args: { sessionId: v.string() },
	returns: v.object({ status: vCheckoutAttemptStatus, paymentId: v.union(v.string(), v.null()) }),
	handler: async (_ctx, { sessionId }) => {
		try {
			const session = await createDodoClient().checkoutSessions.retrieve(sessionId);

			return { status: checkoutStatus(session), paymentId: session.payment_id ?? null };
		} catch (error) {
			if (error instanceof DodoPayments.NotFoundError) {
				throw new ConvexError('Unknown checkout attempt.');
			}

			throw error;
		}
	}
});

export const createCustomerPortal = internalAction({
	args: { dodoCustomerId: v.string() },
	returns: v.string(),
	handler: async (_ctx, { dodoCustomerId }) => {
		const session = await createDodoClient().customers.customerPortal.create(dodoCustomerId, {
			send_email: false
		});

		if (!session.link) throw new Error('Dodo did not return a customer portal URL.');

		return session.link;
	}
});

/** Null when the product can't be sold at `interval`; throws on request failures. */
async function fetchPrice(
	client: DodoPayments,
	productId: string,
	interval: BillingInterval
): Promise<Price | null> {
	const { name, price } = await client.products.retrieve(productId);

	if (
		price.type !== 'recurring_price' ||
		price.price <= 0 ||
		!matchesBillingInterval(
			interval,
			price.payment_frequency_count,
			price.payment_frequency_interval
		)
	) {
		console.error(`Dodo product ${productId} is not a paid ${interval} subscription.`);

		return null;
	}

	return {
		productId,
		name: name ?? null,
		amountMinor: price.price,
		currency: price.currency,
		paymentFrequencyCount: price.payment_frequency_count,
		paymentFrequencyInterval: price.payment_frequency_interval
	};
}

/** Null when the product isn't a paid one-time product; throws on request failures. */
async function fetchPackPrice(client: DodoPayments, productId: string): Promise<PackPrice | null> {
	const { price } = await client.products.retrieve(productId);

	if (price.type !== 'one_time_price' || price.price <= 0) {
		console.error(`Dodo product ${productId} is not a paid one-time product.`);

		return null;
	}

	return { productId, amountMinor: price.price, currency: price.currency };
}

/** Keeps the last price when Dodo can't be reached. */
export const syncPrices = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		if (!env.DODO_PAYMENTS_API_KEY?.trim()) return null;

		const products = await ctx.runQuery(internal.pricing.listTierProducts, {});
		const client = createDodoClient();

		for (const product of products) {
			let price;

			try {
				price = await fetchPrice(client, product.productId, product.interval);
			} catch (error) {
				console.error(`Could not load Dodo product ${product.productId}.`, error);

				continue;
			}

			await ctx.runMutation(internal.pricing.setTierPrice, {
				tierId: product.tierId,
				interval: product.interval,
				price
			});
		}

		for (const productId of await ctx.runQuery(internal.credits.listPackProducts, {})) {
			let price;

			try {
				price = await fetchPackPrice(client, productId);
			} catch (error) {
				console.error(`Could not load Dodo product ${productId}.`, error);

				continue;
			}

			await ctx.runMutation(internal.credits.setPackPrice, { productId, price });
		}

		return null;
	}
});
