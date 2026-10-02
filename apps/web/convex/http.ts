import { createDodoWebhookHandler, type Subscription } from '@dodopayments/convex';
import { httpRouter, type GenericActionCtx, type GenericDataModel } from 'convex/server';
import type { Infer } from 'convex/values';
import { z } from 'zod';
import { internal } from '@convex/_generated/api';
import { classifyBillingInterval } from '@convex/lib/dodoProducts';
import { vSubscriptionStatus } from '@convex/lib/validators';

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

async function persistSubscription(
	ctx: GenericActionCtx<GenericDataModel>,
	data: Subscription,
	status: Infer<typeof vSubscriptionStatus>,
	timestamp: Date | string | undefined,
	preferConfiguredTier = false
): Promise<void> {
	const metadata = subscriptionMetadataSchema.safeParse(data.metadata);
	const eventAt = eventTimestampMs(timestamp);

	const interval = classifyBillingInterval(
		data.payment_frequency_count,
		data.payment_frequency_interval
	);

	if (!interval) throw new Error('Dodo subscription has an unsupported billing interval.');

	await ctx.runMutation(internal.billing.upsertDodoSubscription, {
		userId: metadata.success ? metadata.data.userId : undefined,
		tier: metadata.success ? metadata.data.tierId : undefined,
		checkoutAttemptId: metadata.success ? metadata.data.checkoutAttemptId : undefined,
		preferConfiguredTier:
			preferConfiguredTier &&
			(!data.scheduled_change || eventTimestampMs(data.scheduled_change.effective_at) <= eventAt),
		dodoSubscriptionId: data.subscription_id,
		dodoProductId: data.product_id,
		dodoCustomerId: data.customer.customer_id,
		status,
		eventAt,
		billingInterval: interval,
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

			if (
				status === 'active' ||
				status === 'on_hold' ||
				status === 'cancelled' ||
				status === 'expired' ||
				status === 'failed'
			) {
				await persistSubscription(ctx, payload.data, status, payload.timestamp);
			}
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
