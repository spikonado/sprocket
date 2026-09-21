'use node';

import DodoPayments from 'dodopayments';
import { v } from 'convex/values';
import { internal } from '@convex/_generated/api';
import { action, internalAction } from '@convex/_generated/server';
import {
	matchesBillingInterval,
	readDodoEnvironment,
	readProProductIds,
	type BillingInterval
} from '@convex/lib/dodoProducts';
import { vBillingInterval } from '@convex/lib/validators';

const vDodoPublicPrice = v.object({
	productId: v.string(),
	name: v.union(v.string(), v.null()),
	amountMinor: v.number(),
	currency: v.string(),
	paymentFrequencyCount: v.number(),
	paymentFrequencyInterval: v.string()
});

const vPublicPricingCatalog = v.object({
	plans: v.array(
		v.object({
			id: v.union(v.literal('free'), v.literal('pro')),
			label: v.string(),
			monthlyUsageDollars: v.number()
		})
	),
	proPrices: v.union(
		v.null(),
		v.object({
			monthly: vDodoPublicPrice,
			annual: vDodoPublicPrice
		})
	)
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

export const validateCheckoutProduct = internalAction({
	args: { productId: v.string(), interval: vBillingInterval },
	returns: v.null(),
	handler: async (_ctx, { productId, interval }) => {
		await retrieveProPrice(createDodoClient(), productId, interval);
		return null;
	}
});

export const getPublicCatalog = action({
	args: {},
	returns: vPublicPricingCatalog,
	handler: async (ctx) => {
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
			const client = createDodoClient();
			const [monthly, annual] = await Promise.all([
				retrieveProPrice(client, productIds.monthly, 'monthly'),
				retrieveProPrice(client, productIds.annual, 'annual')
			]);
			if (monthly.currency !== annual.currency) {
				throw new Error('Dodo Pro products use different currencies.');
			}
			return { plans, proPrices: { monthly, annual } };
		} catch (error) {
			console.error('Could not load Dodo product prices.', error);
			return { plans, proPrices: null };
		}
	}
});
