import { DodoPayments } from '@dodopayments/convex';
import { v } from 'convex/values';
import { components, internal } from '@convex/_generated/api';
import {
	action,
	internalMutation,
	internalQuery,
	mutation,
	query
} from '@convex/_generated/server';
import { ensureCurrentUser, getUserId, requireIdentity } from '@convex/lib/auth';
import { productIdForCheckout, readDodoEnvironment } from '@convex/lib/dodoProducts';
import { resolveMarketingPricingUrls } from '@convex/lib/marketingOrigin';
import {
	ensureSubscription,
	getSubscriptionDoc,
	getSubscriptionDocExclusive,
	getSubscriptionTier,
	getTierLabel
} from '@convex/lib/tiers';
import { vBillingInterval, vSubscriptionStatus, vSubscriptionTier } from '@convex/lib/validators';

const dodo = new DodoPayments(components.dodopayments, {
	identify: async (ctx): Promise<{ dodoCustomerId: string } | null> => {
		const userId = await getUserId(ctx);
		const customer = await ctx.runQuery(internal.billingCustomers.getManageable, { userId });
		return customer ? { dodoCustomerId: customer.dodoCustomerId } : null;
	},
	apiKey: process.env.DODO_PAYMENTS_API_KEY!,
	environment: readDodoEnvironment()
});
const payments = dodo.api();

function assertPaymentsConfigured(): void {
	if (!process.env.DODO_PAYMENTS_API_KEY?.trim()) throw new Error('Payments are not configured.');
}

export const getSubscriptionTierForUser = internalQuery({
	args: { userId: v.string() },
	returns: vSubscriptionTier,
	handler: async (ctx, { userId }) => await getSubscriptionTier(ctx, userId)
});

export const getDodoSubscriptionTier = internalQuery({
	args: { userId: v.string(), dodoSubscriptionId: v.string() },
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, { userId, dodoSubscriptionId }) => {
		const subscription = await getSubscriptionDoc(ctx, userId);
		return subscription?.dodoSubscriptionId === dodoSubscriptionId ? subscription.tier : null;
	}
});

export const getMySubscription = query({
	args: {},
	returns: v.object({
		tier: vSubscriptionTier,
		tierLabel: v.string(),
		billingManaged: v.boolean()
	}),
	handler: async (ctx) => {
		const userId = await getUserId(ctx);
		const subscription = await getSubscriptionDoc(ctx, userId);
		const tier = subscription?.status === 'active' ? subscription.tier : 'free';
		const customer = subscription?.dodoSubscriptionId
			? await ctx.db
					.query('billingCustomers')
					.withIndex('by_userId', (query) => query.eq('userId', userId))
					.unique()
			: null;
		return {
			tier,
			tierLabel: await getTierLabel(ctx, tier),
			billingManaged: subscription?.status === 'active' && tier === 'pro' && customer !== null
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
		tier: v.literal('pro'),
		interval: vBillingInterval
	},
	returns: v.object({ checkout_url: v.string() }),
	handler: async (ctx, { tier, interval }): Promise<{ checkout_url: string }> => {
		const identity = await requireIdentity(ctx);
		const currentTier: string = await ctx.runQuery(internal.billing.getSubscriptionTierForUser, {
			userId: identity.subject
		});
		if (currentTier !== 'free') throw new Error('A paid plan is already active on this account.');

		const productId = productIdForCheckout(tier, interval);
		if (!productId) throw new Error(`No checkout product is configured for the ${interval} plan.`);
		assertPaymentsConfigured();
		await ctx.runAction(internal.pricing.validateCheckoutProduct, { productId, interval });

		const billingCustomer = await ctx.runQuery(internal.billingCustomers.get, {
			userId: identity.subject
		});
		const email = identity.email?.trim();
		if (!billingCustomer && !email) throw new Error('Your account does not have a billing email.');
		const { return_url, cancel_url } = resolveMarketingPricingUrls();
		const session = await payments.checkout(ctx, {
			payload: {
				product_cart: [{ product_id: productId, quantity: 1 }],
				metadata: { userId: identity.subject },
				return_url,
				cancel_url,
				feature_flags: { allow_discount_code: true },
				customer: billingCustomer
					? { customer_id: billingCustomer.dodoCustomerId }
					: {
							email: email!,
							name: identity.name ?? identity.nickname ?? email!
						}
			}
		});
		if (!session.checkout_url) throw new Error('Checkout session did not return a URL.');
		return { checkout_url: session.checkout_url };
	}
});

export const customerPortal = action({
	args: {},
	returns: v.object({ portal_url: v.string() }),
	handler: async (ctx) => {
		assertPaymentsConfigured();
		await getUserId(ctx);
		const portal = await payments.customerPortal(ctx, { send_email: false });
		if (!portal.portal_url) throw new Error('Customer portal did not return a URL.');
		return { portal_url: portal.portal_url };
	}
});

export const upsertDodoSubscription = internalMutation({
	args: {
		userId: v.string(),
		tier: v.string(),
		dodoSubscriptionId: v.string(),
		dodoProductId: v.string(),
		dodoCustomerId: v.string(),
		status: vSubscriptionStatus,
		eventAt: v.number()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const existing = await getSubscriptionDocExclusive(ctx, args.userId);
		if (existing?.status === 'active' && !['free', 'pro'].includes(existing.tier)) return null;
		if (existing && args.eventAt < existing.eventAt) return null;
		if (existing && args.eventAt === existing.eventAt && existing.status !== 'active') {
			if (args.status === 'active') return null;
		}
		if (
			existing?.dodoSubscriptionId &&
			args.status !== 'active' &&
			existing.dodoSubscriptionId !== args.dodoSubscriptionId
		) {
			return null;
		}

		const customer = await ctx.db
			.query('billingCustomers')
			.withIndex('by_userId', (query) => query.eq('userId', args.userId))
			.unique();
		if (customer) await ctx.db.patch(customer._id, { dodoCustomerId: args.dodoCustomerId });
		else {
			await ctx.db.insert('billingCustomers', {
				userId: args.userId,
				dodoCustomerId: args.dodoCustomerId
			});
		}

		const subscription = {
			userId: args.userId,
			tier: args.tier,
			status: args.status,
			eventAt: args.eventAt,
			dodoSubscriptionId: args.dodoSubscriptionId,
			dodoProductId: args.dodoProductId
		};
		if (existing) await ctx.db.replace(existing._id, subscription);
		else await ctx.db.insert('subscriptions', subscription);
		return null;
	}
});
