'use node';

import DodoPayments from 'dodopayments';
import { v } from 'convex/values';
import { internal } from '@convex/_generated/api';
import { action, internalAction } from '@convex/_generated/server';
import {
	matchesBillingInterval,
	readDodoEnvironment,
	readProProductIds,
	vDodoPublicPrice,
	vDodoProPrices,
	type BillingInterval,
	type DodoProPrices
} from '@convex/lib/dodoProducts';
import { vBillingInterval } from '@convex/lib/validators';

const DODO_PRICE_CACHE_TTL_MS = 5 * 60 * 1_000;

type PublicPricingPlan = {
	id: string;
	label: string;
	weeklyUsageDollars: number;
	monthlyUsageDollars: number;
	description: string | null;
	features: string[];
	displayOrder: number;
	highlighted: boolean;
	prices: { monthly: DodoProPrices['monthly'] | null; annual: DodoProPrices['annual'] | null };
};

type TierPricingConfig = Omit<PublicPricingPlan, 'prices'> & {
	monthlyProductId: string | null;
	annualProductId: string | null;
};

type PublicPricingCatalog = {
	plans: PublicPricingPlan[];
	proPrices: DodoProPrices | null;
};

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

const vOptionalDodoPrice = v.union(v.null(), vDodoPublicPrice);
const vPublicPricingCatalog = v.object({
	plans: v.array(
		v.object({
			id: v.string(),
			label: v.string(),
			weeklyUsageDollars: v.number(),
			monthlyUsageDollars: v.number(),
			description: v.union(v.string(), v.null()),
			features: v.array(v.string()),
			displayOrder: v.number(),
			highlighted: v.boolean(),
			prices: v.object({ monthly: vOptionalDodoPrice, annual: vOptionalDodoPrice })
		})
	),
	proPrices: v.union(v.null(), vDodoProPrices)
});

function createDodoClient(): DodoPayments {
	return new DodoPayments({
		bearerToken: process.env.DODO_PAYMENTS_API_KEY,
		environment: readDodoEnvironment()
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

export const createCheckoutSession = internalAction({
	args: {
		attemptId: v.string(),
		userId: v.string(),
		tierId: v.string(),
		productId: v.string(),
		interval: vBillingInterval,
		returnUrl: v.string(),
		cancelUrl: v.string(),
		customer: v.union(
			v.object({ customer_id: v.string() }),
			v.object({ email: v.string(), name: v.string() })
		)
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
				feature_flags: { allow_discount_code: true },
				customer: args.customer
			},
			{ headers: { 'Idempotency-Key': args.attemptId } }
		);
		if (!session.checkout_url) throw new Error('Checkout session did not return a URL.');
		return { checkoutUrl: session.checkout_url };
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
		const legacyProProducts = readProProductIds();
		const configs = tierConfigs.map((plan) =>
			plan.id === 'pro'
				? {
						...plan,
						monthlyProductId: plan.monthlyProductId ?? legacyProProducts.monthly ?? null,
						annualProductId: plan.annualProductId ?? legacyProProducts.annual ?? null
					}
				: plan
		);
		const emptyPlans = configs.map((plan) =>
			publicPlanFromConfig(plan, { monthly: null, annual: null })
		);
		const configuredProducts = configs.flatMap((plan) =>
			(['monthly', 'annual'] as const).flatMap((interval) => {
				const productId = interval === 'monthly' ? plan.monthlyProductId : plan.annualProductId;
				return productId ? [{ tierId: plan.id, interval, productId }] : [];
			})
		);
		const productOwners = new Map<string, { tierId: string; interval: BillingInterval }>();
		for (const product of configuredProducts) {
			const owner = productOwners.get(product.productId);
			if (owner) {
				throw new Error(
					`Dodo product "${product.productId}" is assigned to both ${owner.tierId} ${owner.interval} and ${product.tierId} ${product.interval}.`
				);
			}
			productOwners.set(product.productId, product);
		}
		if (configuredProducts.length === 0 || !process.env.DODO_PAYMENTS_API_KEY?.trim()) {
			return { plans: emptyPlans, proPrices: null };
		}

		try {
			const cacheKey = `${readDodoEnvironment()}:${configuredProducts
				.map(({ tierId, interval, productId }) => `${tierId}:${interval}:${productId}`)
				.sort()
				.join('|')}`;
			const now = Date.now();
			let tierPrices: Array<{
				tierId: string;
				interval: BillingInterval;
				price: DodoProPrices['monthly'];
			}> | null = await ctx.runQuery(internal.pricingData.getCachedTierPrices, {
				cacheKey,
				now
			});
			if (!tierPrices) {
				const client = createDodoClient();
				const retrieved = await Promise.all(
					configuredProducts.map(async ({ tierId, interval, productId }) => ({
						tierId,
						interval,
						price: await retrieveRecurringPrice(client, productId, interval)
					}))
				);
				for (const plan of configs) {
					const prices = retrieved.filter((entry) => entry.tierId === plan.id);
					if (prices.length === 2 && prices[0].price.currency !== prices[1].price.currency) {
						throw new Error(`Dodo products for tier "${plan.id}" use different currencies.`);
					}
				}
				tierPrices = retrieved;
				await ctx.runMutation(internal.pricingData.cacheTierPrices, {
					cacheKey,
					tierPrices,
					expiresAt: now + DODO_PRICE_CACHE_TTL_MS
				});
			}
			const plans = configs.map((plan) =>
				publicPlanFromConfig(plan, {
					monthly:
						tierPrices?.find((entry) => entry.tierId === plan.id && entry.interval === 'monthly')
							?.price ?? null,
					annual:
						tierPrices?.find((entry) => entry.tierId === plan.id && entry.interval === 'annual')
							?.price ?? null
				})
			);
			const pro = plans.find((plan) => plan.id === 'pro');
			const proPrices =
				pro?.prices.monthly && pro.prices.annual
					? { monthly: pro.prices.monthly, annual: pro.prices.annual }
					: null;
			return { plans, proPrices };
		} catch (error) {
			console.error('Could not load Dodo product prices.', error);
			return { plans: emptyPlans, proPrices: null };
		}
	}
});
