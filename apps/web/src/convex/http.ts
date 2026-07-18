import { createDodoWebhookHandler, type Subscription } from '@dodopayments/convex';
import { httpRouter, type GenericActionCtx, type GenericDataModel } from 'convex/server';
import type { Infer } from 'convex/values';
import { internal } from '@convex/_generated/api';
import { tierForProductId } from '@convex/lib/tiers';
import { vSubscriptionStatus } from '@convex/lib/validators';

const http = httpRouter();

function eventTimestampMs(timestamp: Date | string | undefined): number {
	const ms =
		timestamp instanceof Date
			? timestamp.getTime()
			: timestamp
				? Date.parse(timestamp)
				: Number.NaN;
	// An unknown provider time must never win ordering over a known one.
	return Number.isFinite(ms) ? ms : 0;
}

async function persistSubscription(
	ctx: GenericActionCtx<GenericDataModel>,
	data: Subscription,
	status: Infer<typeof vSubscriptionStatus>,
	timestamp: Date | string | undefined
): Promise<void> {
	const userId = typeof data.metadata?.userId === 'string' ? data.metadata.userId : undefined;
	if (!userId) {
		console.error(
			'Skipping Dodo subscription webhook without Sprocket userId.',
			data.subscription_id
		);
		return;
	}
	const tier = tierForProductId(data.product_id);
	if (tier === undefined) {
		console.warn('Unknown Dodo product; keeping user on free tier.', data.product_id);
	}
	await ctx.runMutation(internal.billing.upsertSubscription, {
		userId,
		tier: tier ?? 'free',
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
