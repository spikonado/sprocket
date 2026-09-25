import { createDodoWebhookHandler, type Subscription } from '@dodopayments/convex';
import { httpRouter, type GenericActionCtx, type GenericDataModel } from 'convex/server';
import type { Infer } from 'convex/values';
import { z } from 'zod';
import { internal } from '@convex/_generated/api';
import { resolveSubscriptionTier } from '@convex/lib/dodoSubscription';
import { vSubscriptionStatus } from '@convex/lib/validators';

type BillingInterval = 'monthly' | 'annual';

const http = httpRouter();
const subscriptionMetadataSchema = z.object({
	userId: z.string().optional(),
	tierId: z.string().optional(),
	checkoutAttemptId: z.string().optional()
});

function eventTimestampMs(timestamp: Date | string | undefined): number {
	const milliseconds =
		timestamp instanceof Date
			? timestamp.getTime()
			: timestamp
				? Date.parse(timestamp)
				: Number.NaN;
	if (!Number.isFinite(milliseconds)) throw new Error('Dodo webhook has an invalid timestamp.');
	return milliseconds;
}

function billingInterval(data: Subscription): BillingInterval {
	if (data.payment_frequency_interval === 'Month' && data.payment_frequency_count === 1)
		return 'monthly';
	if (
		(data.payment_frequency_interval === 'Year' && data.payment_frequency_count === 1) ||
		(data.payment_frequency_interval === 'Month' && data.payment_frequency_count === 12)
	)
		return 'annual';
	throw new Error('Dodo subscription has an unsupported billing interval.');
}

async function persistSubscription(
	ctx: GenericActionCtx<GenericDataModel>,
	data: Subscription,
	status: Infer<typeof vSubscriptionStatus>,
	timestamp: Date | string | undefined,
	preferConfiguredTier = false
): Promise<void> {
	const metadata = subscriptionMetadataSchema.safeParse(data.metadata);
	const metadataUserId = metadata.success ? metadata.data.userId : undefined;
	const knownCustomer = metadataUserId
		? null
		: await ctx.runQuery(internal.billingCustomers.getByDodoId, {
				dodoCustomerId: data.customer.customer_id
			});
	const userId = metadataUserId ?? knownCustomer?.userId;
	if (!userId) {
		console.error('Ignoring Dodo subscription without a Sprocket user.', data.subscription_id);
		return;
	}
	const metadataCheckoutAttemptId = metadata.success ? metadata.data.checkoutAttemptId : undefined;
	const checkoutTier: string | null =
		metadataUserId && metadataCheckoutAttemptId
			? await ctx.runQuery(internal.billing.getCheckoutTier, {
					userId,
					attemptId: metadataCheckoutAttemptId,
					productId: data.product_id
				})
			: null;
	const existingTier: string | null = await ctx.runQuery(internal.billing.getDodoSubscriptionTier, {
		userId,
		dodoSubscriptionId: data.subscription_id
	});
	const storedTier: string | null = await ctx.runQuery(internal.pricingData.getTierForProduct, {
		productId: data.product_id
	});
	const tier = resolveSubscriptionTier({
		checkoutTier,
		metadataTier: metadata.success ? metadata.data.tierId : undefined,
		existingTier,
		configuredTier: storedTier,
		preferConfiguredTier:
			preferConfiguredTier &&
			(!data.scheduled_change ||
				eventTimestampMs(data.scheduled_change.effective_at) <= eventTimestampMs(timestamp))
	});
	if (!tier) {
		console.warn('Ignoring Dodo subscription for an unknown product.', data.product_id);
		return;
	}

	await ctx.runMutation(internal.billing.upsertDodoSubscription, {
		userId,
		tier,
		dodoSubscriptionId: data.subscription_id,
		dodoProductId: data.product_id,
		dodoCustomerId: data.customer.customer_id,
		status,
		eventAt: eventTimestampMs(timestamp),
		billingInterval: billingInterval(data),
		billingPeriodStart: eventTimestampMs(data.previous_billing_date),
		billingPeriodEnd: eventTimestampMs(data.next_billing_date),
		cancelAtNextBillingDate: data.cancel_at_next_billing_date
	});
}

http.route({
	path: '/dodopayments-webhook',
	method: 'POST',
	handler: createDodoWebhookHandler({
		onSubscriptionActive: (ctx, payload) =>
			persistSubscription(ctx, payload.data, 'active', payload.timestamp),
		onSubscriptionRenewed: (ctx, payload) =>
			persistSubscription(ctx, payload.data, 'active', payload.timestamp),
		onSubscriptionPlanChanged: (ctx, payload) =>
			persistSubscription(ctx, payload.data, 'active', payload.timestamp, true),
		onSubscriptionUpdated: async (ctx, payload) => {
			const status = payload.data.status;
			if (!['active', 'on_hold', 'cancelled', 'expired', 'failed'].includes(status)) return;
			await persistSubscription(
				ctx,
				payload.data,
				status as Infer<typeof vSubscriptionStatus>,
				payload.timestamp,
				true
			);
		},
		onSubscriptionOnHold: (ctx, payload) =>
			persistSubscription(ctx, payload.data, 'on_hold', payload.timestamp),
		onSubscriptionCancelled: (ctx, payload) =>
			persistSubscription(ctx, payload.data, 'cancelled', payload.timestamp),
		onSubscriptionExpired: (ctx, payload) =>
			persistSubscription(ctx, payload.data, 'expired', payload.timestamp),
		onSubscriptionFailed: (ctx, payload) =>
			persistSubscription(ctx, payload.data, 'failed', payload.timestamp)
	})
});

export default http;
