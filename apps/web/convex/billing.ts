import { v } from 'convex/values';
import { internal } from '@convex/_generated/api';
import { action, env, internalMutation, mutation, query } from '@convex/_generated/server';
import { ensureCurrentUser, getUserId, requireIdentity } from '@convex/lib/auth';
import { resolveSubscriptionTier } from '@convex/lib/dodoSubscription';
import { resolveMarketingPricingUrls } from '@convex/lib/marketingOrigin';
import {
	ensureSubscription,
	getSubscriptionDoc,
	getSubscriptionDocExclusive,
	getTierLabel,
	subscriptionIsActive,
	subscriptionTier
} from '@convex/lib/tiers';
import { vBillingInterval, vSubscriptionStatus, vSubscriptionTier } from '@convex/lib/validators';
import { scheduleSubscriptionExpiry } from '@convex/subscriptionExpiry';
import { lookupTierForProduct } from '@convex/pricingData';

const CHECKOUT_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

function assertPaymentsConfigured(): void {
	if (!env.DODO_PAYMENTS_API_KEY?.trim()) throw new Error('Payments are not configured.');
}

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
		const tier = subscriptionTier(subscription);

		const customer = await ctx.db
			.query('billingCustomers')
			.withIndex('by_userId', (query) => query.eq('userId', userId))
			.unique();

		return {
			tier,
			tierLabel: await getTierLabel(ctx, tier),
			billingManaged: customer !== null
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

		const reserved = await ctx.runMutation(internal.billing.reserveCheckoutSession, {
			userId: identity.subject,
			attemptId: crypto.randomUUID(),
			tierId: tier,
			interval,
			productId,
			now: Date.now()
		});

		if (reserved.kind === 'existing') return { checkout_url: reserved.checkoutUrl };

		const dodoCustomerId: string = await ctx.runAction(internal.pricing.ensureCustomer, {
			userId: identity.subject,
			email: identity.email,
			name: identity.name ?? identity.nickname ?? identity.email ?? identity.subject
		});

		const { return_url, cancel_url } = resolveMarketingPricingUrls(env, tier);

		const session = await ctx.runAction(internal.pricing.createCheckoutSession, {
			attemptId: reserved.attemptId,
			userId: identity.subject,
			tierId: tier,
			productId: reserved.productId,
			interval: reserved.interval,
			returnUrl: return_url,
			cancelUrl: cancel_url,
			dodoCustomerId
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

		if (subscriptionIsActive(subscription, args.now) && subscription.tier !== 'free') {
			throw new Error('A paid plan is already active on this account.');
		}

		const existing = await ctx.db
			.query('billingCheckoutSessions')
			.withIndex('by_userId', (query) => query.eq('userId', args.userId))
			.unique();

		if (
			existing &&
			existing.expiresAt > args.now &&
			existing.tierId === args.tierId &&
			existing.interval === args.interval &&
			existing.productId === args.productId
		) {
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

		if (existing) await ctx.db.replace('billingCheckoutSessions', existing._id, reservation);
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

		await ctx.db.patch('billingCheckoutSessions', reservation._id, {
			checkoutUrl: args.checkoutUrl
		});

		return null;
	}
});

export const customerPortal = action({
	args: {},
	returns: v.object({ portal_url: v.string() }),
	handler: async (ctx): Promise<{ portal_url: string }> => {
		assertPaymentsConfigured();
		const userId = await getUserId(ctx);
		const customer = await ctx.runQuery(internal.billingCustomers.get, { userId });

		if (!customer) throw new Error('This account does not have a billing customer.');

		const portal = await ctx.runAction(internal.pricing.createCustomerPortal, {
			dodoCustomerId: customer.dodoCustomerId
		});

		return { portal_url: portal.portal_url };
	}
});

export const upsertDodoSubscription = internalMutation({
	args: {
		userId: v.optional(v.string()),
		tier: v.optional(v.string()),
		checkoutAttemptId: v.optional(v.string()),
		preferConfiguredTier: v.optional(v.boolean()),
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

		const knownCustomer = await ctx.db
			.query('billingCustomers')
			.withIndex('by_dodoCustomerId', (query) => query.eq('dodoCustomerId', args.dodoCustomerId))
			.unique();

		const userId = args.userId ?? knownCustomer?.userId;

		if (!userId) {
			console.error('Ignoring Dodo subscription without a Sprocket user.', args.dodoSubscriptionId);

			return null;
		}

		if (knownCustomer && knownCustomer.userId !== userId) {
			throw new Error('Dodo subscription customer does not match this account.');
		}

		const existing = await getSubscriptionDocExclusive(ctx, userId);

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

		if (
			existing &&
			args.eventAt === existing.eventAt &&
			existing.status !== 'active' &&
			args.status === 'active'
		) {
			return null;
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
			.withIndex('by_userId', (query) => query.eq('userId', userId))
			.unique();

		if (customer && customer.dodoCustomerId !== args.dodoCustomerId) {
			throw new Error('Dodo subscription customer does not match this account.');
		}

		const checkoutSession = await ctx.db
			.query('billingCheckoutSessions')
			.withIndex('by_userId', (query) => query.eq('userId', userId))
			.unique();

		const checkoutTier =
			checkoutSession &&
			checkoutSession.attemptId === args.checkoutAttemptId &&
			checkoutSession.productId === args.dodoProductId
				? checkoutSession.tierId
				: null;

		const existingTier =
			existing?.dodoSubscriptionId === args.dodoSubscriptionId ? existing.tier : null;

		const needsConfiguredTier =
			!checkoutTier && (args.preferConfiguredTier || (!existingTier && !args.tier));

		const tier = resolveSubscriptionTier({
			checkoutTier,
			metadataTier: args.tier,
			existingTier,
			configuredTier: needsConfiguredTier
				? await lookupTierForProduct(ctx, args.dodoProductId)
				: null,
			preferConfiguredTier: args.preferConfiguredTier
		});

		if (!tier) {
			console.warn('Ignoring Dodo subscription for an unknown product.', args.dodoProductId);

			return null;
		}

		if (!customer) {
			await ctx.db.insert('billingCustomers', { userId, dodoCustomerId: args.dodoCustomerId });
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

		const isPlanChange = args.status === 'active' && existing && existing.tier !== tier;

		const subscription = {
			userId,
			tier,
			status: effectiveStatus,
			eventAt: args.eventAt,
			billingInterval: args.billingInterval,
			billingPeriodStart: args.billingPeriodStart,
			billingPeriodEnd: args.billingPeriodEnd,
			billingPeriodEnded: existing?.billingPeriodEnded,
			billingPeriodCheckId: existing?.billingPeriodCheckId,
			cancelAtNextBillingDate: args.cancelAtNextBillingDate,
			quotaResetAt:
				isNewPaidTerm || isPlanChange
					? Math.max(args.eventAt, (existing?.quotaResetAt ?? -Infinity) + 1)
					: existing?.quotaResetAt,
			dodoSubscriptionId: args.dodoSubscriptionId,
			dodoProductId: args.dodoProductId
		};

		const subscriptionId = existing?._id ?? (await ctx.db.insert('subscriptions', subscription));

		if (existing) await ctx.db.replace('subscriptions', subscriptionId, subscription);

		await scheduleSubscriptionExpiry(ctx, { _id: subscriptionId, ...subscription });

		if (args.status === 'active' && checkoutSession) {
			await ctx.db.delete('billingCheckoutSessions', checkoutSession._id);
		}

		return null;
	}
});
