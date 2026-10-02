'use node';

import DodoPayments from 'dodopayments';
import { v } from 'convex/values';
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
		environment: readDodoEnvironment(env)
	});
}

async function retrieveRecurringPrice(
	client: DodoPayments,
	productId: string,
	interval: BillingInterval
) {
	const product = await client.products.retrieve(productId);

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
		const existing = await ctx.runQuery(internal.billingCustomers.get, { userId });

		if (existing) return existing.dodoCustomerId;

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

export const createCheckoutSession = internalAction({
	args: {
		attemptId: v.string(),
		userId: v.string(),
		tierId: v.string(),
		productId: v.string(),
		interval: vBillingInterval,
		returnUrl: v.string(),
		cancelUrl: v.string(),
		dodoCustomerId: v.string()
	},
	returns: v.object({ checkoutUrl: v.string() }),
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
			{ headers: { 'Idempotency-Key': args.attemptId } }
		);

		if (!session.checkout_url) throw new Error('Checkout session did not return a URL.');

		return { checkoutUrl: session.checkout_url };
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

		try {
			const cacheKey = `${readDodoEnvironment(env)}:${configuredProducts
				.map(({ tierId, interval, productId }) => `${tierId}:${interval}:${productId}`)
				.sort()
				.join('|')}`;

			const now = Date.now();

			let tierPrices: Array<{
				tierId: string;
				interval: BillingInterval;
				price: DodoPublicPrice;
			}> | null = await ctx.runQuery(internal.pricingData.getCachedTierPrices, {
				cacheKey,
				now
			});

			if (!tierPrices) {
				const client = createDodoClient();

				const retrieved = await Promise.all(
					configuredProducts.map(async ({ tierId, interval, productId }) => {
						if (ambiguousProducts.has(productId)) return null;

						try {
							return {
								tierId,
								interval,
								price: await retrieveRecurringPrice(client, productId, interval)
							};
						} catch (error) {
							console.error(`Could not load Dodo product ${productId}.`, error);

							return null;
						}
					})
				);

				tierPrices = retrieved.filter((entry) => entry !== null);

				if (tierPrices.length === configuredProducts.length) {
					try {
						await ctx.runMutation(internal.pricingData.cacheTierPrices, {
							cacheKey,
							tierPrices,
							expiresAt: now + DODO_PRICE_CACHE_TTL_MS
						});
					} catch (error) {
						console.error('Could not cache Dodo product prices.', error);
					}
				}
			}

			const plans = tierConfigs.map((plan) =>
				publicPlanFromConfig(plan, {
					monthly:
						tierPrices?.find((entry) => entry.tierId === plan.id && entry.interval === 'monthly')
							?.price ?? null,
					annual:
						tierPrices?.find((entry) => entry.tierId === plan.id && entry.interval === 'annual')
							?.price ?? null
				})
			);

			return { plans };
		} catch (error) {
			console.error('Could not load Dodo product prices.', error);

			return { plans: emptyPlans };
		}
	}
});
