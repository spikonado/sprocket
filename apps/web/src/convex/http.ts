import { createDodoWebhookHandler, type Subscription } from '@dodopayments/convex';
import { httpRouter, type GenericActionCtx, type GenericDataModel } from 'convex/server';
import type { Infer } from 'convex/values';
import { z } from 'zod';
import { internal } from '@convex/_generated/api';
import { tierForProductId } from '@convex/lib/dodoProducts';
import { vSubscriptionStatus } from '@convex/lib/validators';

const http = httpRouter();
const subscriptionMetadataSchema = z.object({ userId: z.string().optional() });

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

async function persistSubscription(
	ctx: GenericActionCtx<GenericDataModel>,
	data: Subscription,
	status: Infer<typeof vSubscriptionStatus>,
	timestamp: Date | string | undefined
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
	const storedTier: string | null = await ctx.runQuery(internal.pricingData.getTierForProduct, {
		productId: data.product_id
	});
	const configuredTier = storedTier ?? tierForProductId(data.product_id);
	const existingTier =
		!configuredTier && status !== 'active'
			? await ctx.runQuery(internal.billing.getDodoSubscriptionTier, {
					userId,
					dodoSubscriptionId: data.subscription_id
				})
			: null;
	const tier = configuredTier ?? existingTier;
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
		eventAt: eventTimestampMs(timestamp)
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
			persistSubscription(ctx, payload.data, 'active', payload.timestamp),
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
