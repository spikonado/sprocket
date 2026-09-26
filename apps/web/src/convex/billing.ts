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
import { readDodoEnvironment } from '@convex/lib/dodoProducts';
import { resolveMarketingPricingUrls } from '@convex/lib/marketingOrigin';
import {
	ensureSubscription,
	getSubscriptionDoc,
	getSubscriptionDocExclusive,
	getTierLabel,
	resolveTierLimits,
	subscriptionIsActive
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
const CHECKOUT_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

function assertPaymentsConfigured(): void {
	if (!process.env.DODO_PAYMENTS_API_KEY?.trim()) throw new Error('Payments are not configured.');
}

export const getDodoSubscriptionTier = internalQuery({
	args: { userId: v.string(), dodoSubscriptionId: v.string() },
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, { userId, dodoSubscriptionId }) => {
		const subscription = await getSubscriptionDoc(ctx, userId);
		return subscription?.dodoSubscriptionId === dodoSubscriptionId ? subscription.tier : null;
	}
});

export const getCheckoutTier = internalQuery({
	args: { userId: v.string(), attemptId: v.string(), productId: v.string() },
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, { userId, attemptId, productId }) => {
		const checkout = await ctx.db
			.query('billingCheckoutSessions')
			.withIndex('by_userId', (query) => query.eq('userId', userId))
			.unique();
		return checkout?.attemptId === attemptId && checkout.productId === productId
			? checkout.tierId
			: null;
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
		const tier = subscriptionIsActive(subscription) ? subscription!.tier : 'free';
		const customer = subscription?.dodoSubscriptionId
			? await ctx.db
					.query('billingCustomers')
					.withIndex('by_userId', (query) => query.eq('userId', userId))
					.unique()
			: null;
		return {
			tier,
			tierLabel: await getTierLabel(ctx, tier),
			billingManaged:
				subscriptionIsActive(subscription) &&
				Boolean(subscription?.dodoSubscriptionId) &&
				customer !== null
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
		tier: v.string(),
		interval: vBillingInterval
	},
	returns: v.object({ checkout_url: v.string() }),
	handler: async (ctx, { tier, interval }): Promise<{ checkout_url: string }> => {
		const identity = await requireIdentity(ctx);
		if (tier === 'free') throw new Error('The Free tier does not use checkout.');
		const productId: string | null = await ctx.runQuery(internal.pricingData.getTierProduct, {
			tierId: tier,
			interval
		});
		if (!productId) {
			throw new Error(`No ${interval} checkout product is configured for tier "${tier}".`);
		}
		assertPaymentsConfigured();

		const billingCustomer = await ctx.runQuery(internal.billingCustomers.get, {
			userId: identity.subject
		});
		const email = identity.email?.trim();
		if (!billingCustomer && !email) throw new Error('Your account does not have a billing email.');
		const reserved = await ctx.runMutation(internal.billing.reserveCheckoutSession, {
			userId: identity.subject,
			attemptId: crypto.randomUUID(),
			tierId: tier,
			interval,
			productId,
			now: Date.now()
		});
		if (reserved.kind === 'existing') return { checkout_url: reserved.checkoutUrl };

		const { return_url, cancel_url } = resolveMarketingPricingUrls(process.env, tier);
		const session = await ctx.runAction(internal.pricing.createCheckoutSession, {
			attemptId: reserved.attemptId,
			userId: identity.subject,
			tierId: tier,
			productId: reserved.productId,
			interval: reserved.interval,
			returnUrl: return_url,
			cancelUrl: cancel_url,
			customer: billingCustomer
				? { customer_id: billingCustomer.dodoCustomerId }
				: {
						email: email!,
						name: identity.name ?? identity.nickname ?? email!
					}
		});
		await ctx.runMutation(internal.billing.attachCheckoutSession, {
			userId: identity.subject,
			attemptId: reserved.attemptId,
			checkoutUrl: session.checkoutUrl
		});
		return { checkout_url: session.checkoutUrl };
	}
});

export const reserveCheckoutSession = internalMutation({
	args: {
		userId: v.string(),
		attemptId: v.string(),
		tierId: v.string(),
		interval: vBillingInterval,
		productId: v.string(),
		now: v.number()
	},
	returns: v.union(
		v.object({ kind: v.literal('existing'), checkoutUrl: v.string() }),
		v.object({
			kind: v.literal('create'),
			attemptId: v.string(),
			interval: vBillingInterval,
			productId: v.string()
		})
	),
	handler: async (ctx, args) => {
		const subscription = await getSubscriptionDocExclusive(ctx, args.userId);
		if (subscription?.status === 'active' && subscription.tier !== 'free') {
			throw new Error('A paid plan is already active on this account.');
		}

		const existing = await ctx.db
			.query('billingCheckoutSessions')
			.withIndex('by_userId', (query) => query.eq('userId', args.userId))
			.unique();
		if (existing && existing.expiresAt > args.now) {
			if (
				existing.tierId !== args.tierId ||
				existing.interval !== args.interval ||
				existing.productId !== args.productId
			) {
				throw new Error(
					`A ${existing.interval} checkout is still active. Try that plan again or change plans after it expires.`
				);
			}
			return existing.checkoutUrl
				? { kind: 'existing' as const, checkoutUrl: existing.checkoutUrl }
				: {
						kind: 'create' as const,
						attemptId: existing.attemptId,
						interval: existing.interval,
						productId: existing.productId
					};
		}

		const reservation = {
			userId: args.userId,
			attemptId: args.attemptId,
			tierId: args.tierId,
			interval: args.interval,
			productId: args.productId,
			expiresAt: args.now + CHECKOUT_SESSION_TTL_MS
		};
		if (existing) await ctx.db.replace(existing._id, reservation);
		else await ctx.db.insert('billingCheckoutSessions', reservation);
		return {
			kind: 'create' as const,
			attemptId: args.attemptId,
			interval: args.interval,
			productId: args.productId
		};
	}
});

export const attachCheckoutSession = internalMutation({
	args: { userId: v.string(), attemptId: v.string(), checkoutUrl: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const reservation = await ctx.db
			.query('billingCheckoutSessions')
			.withIndex('by_userId', (query) => query.eq('userId', args.userId))
			.unique();
		if (!reservation || reservation.attemptId !== args.attemptId) {
			throw new Error('Checkout reservation expired.');
		}
		await ctx.db.patch(reservation._id, { checkoutUrl: args.checkoutUrl });
		return null;
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
		eventAt: v.number(),
		billingInterval: vBillingInterval,
		billingPeriodStart: v.number(),
		billingPeriodEnd: v.number(),
		cancelAtNextBillingDate: v.boolean()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		if (args.billingPeriodEnd <= args.billingPeriodStart) {
			throw new Error('Dodo billing period must have a positive duration.');
		}
		const existing = await getSubscriptionDocExclusive(ctx, args.userId);
		if (existing?.status === 'active' && existing.tier !== 'free' && !existing.dodoSubscriptionId) {
			return null;
		}
		if (existing && args.eventAt < existing.eventAt) return null;
		if (
			existing?.dodoSubscriptionId &&
			existing.dodoSubscriptionId !== args.dodoSubscriptionId &&
			subscriptionIsActive(existing)
		) {
			return null;
		}
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

		const effectiveStatus =
			args.status === 'cancelled' &&
			args.cancelAtNextBillingDate &&
			args.eventAt < args.billingPeriodEnd
				? 'active'
				: args.status;
		const isNewPaidTerm =
			effectiveStatus === 'active' &&
			(!existing || existing.dodoSubscriptionId !== args.dodoSubscriptionId);
		const oldLimits =
			args.status === 'active' && existing && existing.tier !== args.tier
				? await resolveTierLimits(ctx, existing.tier)
				: null;
		const newLimits = oldLimits ? await resolveTierLimits(ctx, args.tier) : null;
		const isUpgrade =
			oldLimits !== null &&
			newLimits !== null &&
			newLimits.modelUsage.weekly >= oldLimits.modelUsage.weekly &&
			newLimits.modelUsage.monthly >= oldLimits.modelUsage.monthly &&
			(newLimits.modelUsage.weekly > oldLimits.modelUsage.weekly ||
				newLimits.modelUsage.monthly > oldLimits.modelUsage.monthly);
		const subscription = {
			userId: args.userId,
			tier: args.tier,
			status: effectiveStatus,
			eventAt: args.eventAt,
			billingInterval: args.billingInterval,
			billingPeriodStart: args.billingPeriodStart,
			billingPeriodEnd: args.billingPeriodEnd,
			cancelAtNextBillingDate: args.cancelAtNextBillingDate,
			quotaResetAt:
				isNewPaidTerm || isUpgrade
					? Math.max(args.eventAt, (existing?.quotaResetAt ?? -Infinity) + 1)
					: existing?.quotaResetAt,
			dodoSubscriptionId: args.dodoSubscriptionId,
			dodoProductId: args.dodoProductId
		};
		if (existing) await ctx.db.replace(existing._id, subscription);
		else await ctx.db.insert('subscriptions', subscription);
		if (args.status === 'active') {
			const checkoutSession = await ctx.db
				.query('billingCheckoutSessions')
				.withIndex('by_userId', (query) => query.eq('userId', args.userId))
				.unique();
			if (checkoutSession) await ctx.db.delete('billingCheckoutSessions', checkoutSession._id);
		}
		return null;
	}
});
