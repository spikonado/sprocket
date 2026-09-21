'use node';

import DodoPayments from 'dodopayments';
import { v } from 'convex/values';
import { internal } from '@convex/_generated/api';
import { action, internalAction } from '@convex/_generated/server';
import {
	matchesBillingInterval,
	readDodoEnvironment,
	readProProductIds,
	vDodoProPrices,
	type BillingInterval,
	type DodoProPrices
} from '@convex/lib/dodoProducts';
import { vBillingInterval } from '@convex/lib/validators';

const DODO_PRICE_CACHE_TTL_MS = 5 * 60 * 1_000;

type PublicPricingCatalog = {
	plans: Array<{ id: 'free' | 'pro'; label: string; monthlyUsageDollars: number }>;
	proPrices: DodoProPrices | null;
};

const vPublicPricingCatalog = v.object({
	plans: v.array(
		v.object({
			id: v.union(v.literal('free'), v.literal('pro')),
			label: v.string(),
			monthlyUsageDollars: v.number()
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

async function retrieveProPrice(
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
		await retrieveProPrice(client, args.productId, args.interval);
		const session = await client.checkoutSessions.create(
			{
				product_cart: [{ product_id: args.productId, quantity: 1 }],
				metadata: { userId: args.userId },
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
		const plans: Array<{
			id: 'free' | 'pro';
			label: string;
			monthlyUsageDollars: number;
		}> = await ctx.runQuery(internal.pricingData.getPublicPlans, {});
		const productIds = readProProductIds();
		if (!productIds.monthly || !productIds.annual || !process.env.DODO_PAYMENTS_API_KEY?.trim()) {
			return { plans, proPrices: null };
		}

		try {
			const cacheKey = `${readDodoEnvironment()}:${productIds.monthly}:${productIds.annual}`;
			const now = Date.now();
			const cached: DodoProPrices | null = await ctx.runQuery(
				internal.pricingData.getCachedDodoPrices,
				{
					cacheKey,
					now
				}
			);
			if (cached) return { plans, proPrices: cached };

			const client = createDodoClient();
			const [monthly, annual] = await Promise.all([
				retrieveProPrice(client, productIds.monthly, 'monthly'),
				retrieveProPrice(client, productIds.annual, 'annual')
			]);
			if (monthly.currency !== annual.currency) {
				throw new Error('Dodo Pro products use different currencies.');
			}
			const proPrices = { monthly, annual };
			await ctx.runMutation(internal.pricingData.cacheDodoPrices, {
				cacheKey,
				proPrices,
				expiresAt: now + DODO_PRICE_CACHE_TTL_MS
			});
			return { plans, proPrices };
		} catch (error) {
			console.error('Could not load Dodo product prices.', error);
			return { plans, proPrices: null };
		}
	}
});
