import { ConvexError, v, type Infer } from 'convex/values';
import { api, internal } from '@convex/_generated/api';
import { action, env, internalQuery, mutation, query } from '@convex/_generated/server';
import { ensureCurrentUser, getUserBySubject, getUserId, requireIdentity } from '@convex/lib/auth';
import { readDodoEnvironment } from '@convex/lib/dodoProducts';
import { resolvePlan } from '@convex/lib/tiers';
import {
	vBillingInterval,
	vCheckoutAttemptStatus,
	vDodoMode,
	vSubscriptionTier
} from '@convex/lib/validators';

// Public checkout mode; never the raw provider environment name.
type DodoMode = Infer<typeof vDodoMode>;

type CheckoutStatus = Infer<typeof vCheckoutAttemptStatus>;

function paymentsMode(): DodoMode {
	const environment = readDodoEnvironment(env);

	if (!env.DODO_PAYMENTS_API_KEY?.trim()) throw new ConvexError('Payments are not configured.');

	return environment === 'live_mode' ? 'live' : 'test';
}

function pricingPageUrls(tier: string) {
	const origin = env.SPROCKET_MARKETING_ORIGIN?.trim().replace(/\/$/, '');

	if (!origin) throw new Error('SPROCKET_MARKETING_ORIGIN must be configured for billing.');
	const query = `tier=${encodeURIComponent(tier)}`;

	return {
		returnUrl: `${origin}/pricing?checkout=return&${query}`,
		cancelUrl: `${origin}/pricing?checkout=cancel&${query}`
	};
}

export const getMySubscription = query({
	args: {},
	returns: v.object({
		tier: vSubscriptionTier,
		tierLabel: v.string(),
		billingManaged: v.boolean(),
		accessPhase: v.optional(
			v.union(
				v.literal('active'),
				v.literal('scheduled_cancel'),
				v.literal('ended'),
				v.literal('none')
			)
		)
	}),
	handler: async (ctx) => {
		const userId = await getUserId(ctx);
		const plan = await resolvePlan(ctx, userId, Date.now());
		const user = await getUserBySubject(ctx.db, userId);

		let accessPhase: 'none' | 'scheduled_cancel' | 'active' = 'active';

		if (plan.tier === 'free') accessPhase = 'none';
		else if (plan.subscription?.cancelAtNextBillingDate) accessPhase = 'scheduled_cancel';

		return {
			tier: plan.tier,
			tierLabel: plan.label,
			billingManaged: user?.dodoCustomerId !== undefined,
			accessPhase
		};
	}
});

export const ensureMySubscription = mutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		await ensureCurrentUser(ctx);

		return null;
	}
});

export const checkout = action({
	args: {
		tier: v.string(),
		interval: vBillingInterval
	},
	returns: v.object({
		checkout_url: v.string(),
		mode: vDodoMode,
		attemptId: v.string(),
		sessionId: v.string()
	}),
	handler: async (
		ctx,
		{ tier, interval }
	): Promise<{ checkout_url: string; mode: DodoMode; attemptId: string; sessionId: string }> => {
		const identity = await requireIdentity(ctx);

		if (tier === 'free') throw new ConvexError('The Free tier does not use checkout.');

		const mode = paymentsMode();

		if (!env.DODO_PAYMENTS_WEBHOOK_SECRET?.trim()) {
			throw new ConvexError('Payments are not configured.');
		}

		const productId: string | null = await ctx.runQuery(internal.pricing.getTierProduct, {
			tierId: tier,
			interval
		});

		if (!productId) {
			throw new ConvexError(`No ${interval} checkout product is configured for tier "${tier}".`);
		}

		// The pricing site can start checkout before the app ever created the
		// users row that stores the Dodo customer.
		await ctx.runMutation(api.billing.ensureMySubscription, {});

		const session = await ctx.runAction(internal.dodo.createCheckout, {
			userId: identity.subject,
			email: identity.email,
			name: identity.name ?? identity.nickname ?? identity.email ?? identity.subject,
			productId,
			...pricingPageUrls(tier)
		});

		return {
			checkout_url: session.checkoutUrl,
			mode,
			attemptId: session.sessionId,
			sessionId: session.sessionId
		};
	}
});

/** `attemptId` is the Dodo checkout session ID that `checkout` returned. */
export const getCheckoutStatus = action({
	args: { attemptId: v.string() },
	returns: v.object({
		attemptId: v.string(),
		status: vCheckoutAttemptStatus,
		mode: vDodoMode,
		activated: v.optional(v.boolean())
	}),
	handler: async (
		ctx,
		{ attemptId }
	): Promise<{
		attemptId: string;
		status: CheckoutStatus;
		mode: DodoMode;
		activated?: boolean;
	}> => {
		const identity = await requireIdentity(ctx);
		const mode = paymentsMode();

		const status: CheckoutStatus = await ctx.runAction(internal.dodo.getCheckoutStatus, {
			sessionId: attemptId
		});

		if (status !== 'succeeded') return { attemptId, status, mode };

		// Checkout refuses a second live subscription, so a paid plan comes from this checkout.
		const activated: boolean = await ctx.runQuery(internal.billing.hasPaidPlan, {
			userId: identity.subject,
			now: Date.now()
		});

		return { attemptId, status, mode, activated };
	}
});

export const hasPaidPlan = internalQuery({
	args: { userId: v.string(), now: v.number() },
	returns: v.boolean(),
	handler: async (ctx, { userId, now }) =>
		(await resolvePlan(ctx, userId, now)).subscription !== null
});

export const customerPortal = action({
	args: {},
	returns: v.object({ portal_url: v.string() }),
	handler: async (ctx): Promise<{ portal_url: string }> => {
		paymentsMode();
		const userId = await getUserId(ctx);

		const dodoCustomerId = await ctx.runQuery(internal.billingCustomers.getDodoCustomerId, {
			userId
		});

		if (!dodoCustomerId) throw new ConvexError('This account does not have a billing customer.');

		const portalUrl: string = await ctx.runAction(internal.dodo.createCustomerPortal, {
			dodoCustomerId
		});

		return { portal_url: portalUrl };
	}
});
