import {
	DodoPayments,
	type CheckoutResponse,
	type CustomerPortalResponse
} from '@dodopayments/convex';
import type { ComponentApi } from '@dodopayments/convex/_generated/component';
import { v } from 'convex/values';
import {
	action,
	internalMutation,
	internalQuery,
	mutation,
	query
} from '@convex/_generated/server';
import { components, internal } from '@convex/_generated/api';
import { getUserId } from '@convex/lib/auth';
import {
	ensureSubscription,
	getSubscriptionDocExclusive,
	getSubscriptionTier,
	tierProductIds
} from '@convex/lib/tiers';
import { vSubscriptionStatus, vSubscriptionTier } from '@convex/lib/validators';

export const getBillingCustomer = internalQuery({
	args: { userId: v.string() },
	handler: async (ctx, { userId }) =>
		ctx.db
			.query('billingCustomers')
			.withIndex('by_userId', (q) => q.eq('userId', userId))
			.unique()
});

const dodo: DodoPayments = new DodoPayments(components.dodopayments as ComponentApi, {
	identify: async (ctx): Promise<{ dodoCustomerId: string } | null> => {
		const userId = await getUserId(ctx);
		const customer = await ctx.runQuery(internal.billing.getBillingCustomer, { userId });
		return customer ? { dodoCustomerId: customer.dodoCustomerId } : null;
	},
	apiKey: process.env.DODO_PAYMENTS_API_KEY!,
	environment: (process.env.DODO_PAYMENTS_ENVIRONMENT as 'test_mode' | 'live_mode') ?? 'test_mode'
});
const payments: ReturnType<DodoPayments['api']> = dodo.api();

function assertPaymentsConfigured(): void {
	if (!process.env.DODO_PAYMENTS_API_KEY) throw new Error('Payments are not configured.');
}

export const getMySubscription = query({
	args: {},
	handler: async (ctx) => {
		const userId = await getUserId(ctx);
		return { tier: await getSubscriptionTier(ctx, userId) };
	}
});

export const ensureMySubscription = mutation({
	args: {},
	handler: async (ctx) => {
		const userId = await getUserId(ctx);
		await ensureSubscription(ctx, userId);
	}
});

export const checkout = action({
	args: { tier: vSubscriptionTier },
	handler: async (ctx, { tier }): Promise<CheckoutResponse> => {
		assertPaymentsConfigured();
		const productId = tierProductIds[tier];
		if (!productId) throw new Error(`No checkout product is configured for the ${tier} tier.`);
		const userId = await getUserId(ctx);
		return payments.checkout(ctx, {
			payload: {
				product_cart: [{ product_id: productId, quantity: 1 }],
				metadata: { userId }
			}
		});
	}
});

export const customerPortal = action({
	args: {},
	handler: async (ctx): Promise<CustomerPortalResponse> => {
		assertPaymentsConfigured();
		await getUserId(ctx);
		return payments.customerPortal(ctx);
	}
});

export const upsertSubscription = internalMutation({
	args: {
		userId: v.string(),
		tier: vSubscriptionTier,
		dodoSubscriptionId: v.string(),
		dodoProductId: v.string(),
		dodoCustomerId: v.string(),
		status: vSubscriptionStatus,
		eventAt: v.number()
	},
	handler: async (ctx, args) => {
		const existing = await getSubscriptionDocExclusive(ctx, args.userId);

		const syncBillingCustomer = async () => {
			const customer = await ctx.db
				.query('billingCustomers')
				.withIndex('by_userId', (q) => q.eq('userId', args.userId))
				.unique();
			if (customer) await ctx.db.patch(customer._id, { dodoCustomerId: args.dodoCustomerId });
			else
				await ctx.db.insert('billingCustomers', {
					userId: args.userId,
					dodoCustomerId: args.dodoCustomerId
				});
		};

		// Manual admin grants must not be clobbered by Dodo lifecycle events.
		if (existing?.status === 'active' && existing.tier === 'admin' && args.tier !== 'admin') {
			if (args.eventAt >= existing.eventAt) await syncBillingCustomer();
			return;
		}
		// Ignore out-of-order webhook events; retries (equal eventAt) still apply.
		if (existing && args.eventAt < existing.eventAt) return;
		// A non-active event for a different subscription than the stored one is
		// about a defunct subscription (e.g. a cancellation racing its
		// replacement) and must not downgrade the current one.
		if (
			existing &&
			args.status !== 'active' &&
			(existing.dodoSubscriptionId === '' ||
				existing.dodoSubscriptionId !== args.dodoSubscriptionId)
		) {
			return;
		}
		const subscription = {
			userId: args.userId,
			tier: args.tier,
			dodoSubscriptionId: args.dodoSubscriptionId,
			dodoProductId: args.dodoProductId,
			status: args.status,
			eventAt: args.eventAt
		};
		if (existing) await ctx.db.replace(existing._id, subscription);
		else await ctx.db.insert('subscriptions', subscription);
		await syncBillingCustomer();
	}
});
