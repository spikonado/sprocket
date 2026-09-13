import { DodoPayments } from '@dodopayments/convex';
import type { ComponentApi } from '@dodopayments/convex/_generated/component';
import { components, internal } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import { v } from 'convex/values';
import {
	action,
	env,
	internalMutation,
	internalQuery,
	mutation,
	query,
	type MutationCtx,
	type QueryCtx
} from '@convex/_generated/server';
import { ensureCurrentUser, getUserId } from '@convex/lib/auth';
import { vCheckoutResponse, vCustomerPortalResponse } from '@convex/lib/docs';
import {
	ensureSubscription,
	getSubscriptionDocExclusive,
	getSubscriptionTier,
	tierProductIds
} from '@convex/lib/tiers';
import { vSubscriptionStatus, vSubscriptionTier } from '@convex/lib/validators';
import schema from '@convex/schema';

async function listBillingCustomers(
	ctx: QueryCtx | MutationCtx,
	userId: string
): Promise<Doc<'billingCustomers'>[]> {
	return await ctx.db
		.query('billingCustomers')
		.withIndex('by_userId', (q) => q.eq('userId', userId))
		.collect();
}

/** Mutation-only: collapse concurrent identify/upsert races onto one row. */
async function getBillingCustomerExclusive(
	ctx: MutationCtx,
	userId: string
): Promise<Doc<'billingCustomers'> | null> {
	const rows = await listBillingCustomers(ctx, userId);
	const keep = rows[0] ?? null;
	if (!keep) return null;
	for (const row of rows) {
		if (row._id !== keep._id) await ctx.db.delete('billingCustomers', row._id);
	}
	return keep;
}

export const getBillingCustomer = internalQuery({
	args: { userId: v.string() },
	returns: v.union(schema.doc('billingCustomers'), v.null()),
	handler: async (ctx, { userId }) => (await listBillingCustomers(ctx, userId))[0] ?? null
});

const dodo: DodoPayments = new DodoPayments(
	// SAFETY: the generated dodopayments component handle is the ComponentApi the SDK constructs.
	components.dodopayments as ComponentApi,
	{
		identify: async (ctx): Promise<{ dodoCustomerId: string } | null> => {
			const userId = await getUserId(ctx);
			const customer = await ctx.runQuery(internal.billing.getBillingCustomer, { userId });
			return customer ? { dodoCustomerId: customer.dodoCustomerId } : null;
		},
		apiKey: env.DODO_PAYMENTS_API_KEY ?? '',
		environment: env.DODO_PAYMENTS_ENVIRONMENT ?? 'test_mode'
	}
);
const payments: ReturnType<DodoPayments['api']> = dodo.api();

function assertPaymentsConfigured(): void {
	if (!env.DODO_PAYMENTS_API_KEY) throw new Error('Payments are not configured.');
}

export const getMySubscription = query({
	args: {},
	returns: v.object({ tier: vSubscriptionTier }),
	handler: async (ctx) => {
		const userId = await getUserId(ctx);
		return { tier: await getSubscriptionTier(ctx, userId) };
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
	args: { tier: vSubscriptionTier },
	returns: vCheckoutResponse,
	handler: async (ctx, { tier }) => {
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
	returns: vCustomerPortalResponse,
	handler: async (ctx) => {
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
	returns: v.null(),
	handler: async (ctx, args) => {
		const existing = await getSubscriptionDocExclusive(ctx, args.userId);

		const syncBillingCustomer = async () => {
			const customer = await getBillingCustomerExclusive(ctx, args.userId);
			if (customer)
				await ctx.db.patch('billingCustomers', customer._id, {
					dodoCustomerId: args.dodoCustomerId
				});
			else
				await ctx.db.insert('billingCustomers', {
					userId: args.userId,
					dodoCustomerId: args.dodoCustomerId
				});
		};

		// Manual admin grants must not be clobbered by Dodo lifecycle events.
		if (existing?.status === 'active' && existing.tier === 'admin' && args.tier !== 'admin') {
			if (args.eventAt >= existing.eventAt) await syncBillingCustomer();
			return null;
		}
		// Ignore out-of-order webhook events; retries (equal eventAt) still apply.
		if (existing && args.eventAt < existing.eventAt) return null;
		// A non-active event for a different subscription than the stored one is
		// about a defunct subscription (e.g. a cancellation racing its
		// replacement) and must not downgrade the current one.
		if (
			existing &&
			args.status !== 'active' &&
			(existing.dodoSubscriptionId === '' ||
				existing.dodoSubscriptionId !== args.dodoSubscriptionId)
		) {
			return null;
		}
		const subscription = {
			userId: args.userId,
			tier: args.tier,
			dodoSubscriptionId: args.dodoSubscriptionId,
			dodoProductId: args.dodoProductId,
			status: args.status,
			eventAt: args.eventAt
		};
		if (existing) await ctx.db.replace('subscriptions', existing._id, subscription);
		else await ctx.db.insert('subscriptions', subscription);
		await syncBillingCustomer();
		return null;
	}
});
