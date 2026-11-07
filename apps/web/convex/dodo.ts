'use node';

import DodoPayments from 'dodopayments';
import type { Subscription, SubscriptionListResponse } from 'dodopayments/resources';
import { v } from 'convex/values';
import { z } from 'zod';
import { internal } from '@convex/_generated/api';
import { env, internalAction, type ActionCtx } from '@convex/_generated/server';
import { readDodoEnvironment } from '@convex/lib/dodoProducts';

const subscriptionEventData = z.object({ subscription_id: z.string() });

const checkoutMetadata = z.object({ userId: z.string().optional() });

function createDodoClient(): DodoPayments {
	return new DodoPayments({
		bearerToken: env.DODO_PAYMENTS_API_KEY,
		environment: readDodoEnvironment(env),
		timeout: 8_000
	});
}

function toEpochMs(timestamp: string): number {
	const ms = Date.parse(timestamp);

	if (!Number.isFinite(ms)) throw new Error(`Dodo returned an invalid date "${timestamp}".`);

	return ms;
}

async function mirror(
	ctx: ActionCtx,
	subscription: Subscription | SubscriptionListResponse,
	fetchedAt: number
): Promise<void> {
	await ctx.runMutation(internal.subscriptions.sync, {
		fetchedAt,
		metadataUserId: checkoutMetadata.parse(subscription.metadata).userId,
		dodoCustomerId: subscription.customer.customer_id,
		subscription: {
			dodoSubscriptionId: subscription.subscription_id,
			dodoProductId: subscription.product_id,
			status: subscription.status,
			billingPeriodStart: toEpochMs(subscription.previous_billing_date),
			billingPeriodEnd: toEpochMs(subscription.next_billing_date),
			cancelAtNextBillingDate: subscription.cancel_at_next_billing_date
		}
	});
}

async function syncSubscription(
	ctx: ActionCtx,
	client: DodoPayments,
	dodoSubscriptionId: string
): Promise<void> {
	const fetchedAt = Date.now();
	await mirror(ctx, await client.subscriptions.retrieve(dodoSubscriptionId), fetchedAt);
}

/** Throws on anything retryable so the HTTP route answers 500 and Dodo redelivers. */
export const handleWebhook = internalAction({
	args: { body: v.string(), headers: v.record(v.string(), v.string()) },
	returns: v.union(v.literal('handled'), v.literal('invalid')),
	handler: async (ctx, { body, headers }) => {
		const key = env.DODO_PAYMENTS_WEBHOOK_SECRET?.trim();

		if (!key) throw new Error('DODO_PAYMENTS_WEBHOOK_SECRET is not configured.');
		const client = createDodoClient();
		let event;

		try {
			event = client.webhooks.unwrap(body, { headers, key });
		} catch {
			return 'invalid';
		}

		if (event.type.startsWith('subscription.')) {
			await syncSubscription(ctx, client, subscriptionEventData.parse(event.data).subscription_id);
		}

		return 'handled';
	}
});

/** One page covers a customer; checkout refuses a second live subscription. */
export const syncCustomer = internalAction({
	args: { dodoCustomerId: v.string() },
	returns: v.null(),
	handler: async (ctx, { dodoCustomerId }) => {
		const fetchedAt = Date.now();

		const page = await createDodoClient().subscriptions.list({
			customer_id: dodoCustomerId,
			page_size: 100
		});

		for (const subscription of page.items) await mirror(ctx, subscription, fetchedAt);

		return null;
	}
});

/** Catches renewals and cancellations whose webhooks never arrived. */
export const syncOverdue = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const ids = await ctx.runQuery(internal.subscriptions.listOverdue, { now: Date.now() });
		const client = createDodoClient();

		for (const id of ids) {
			try {
				await syncSubscription(ctx, client, id);
			} catch (error) {
				console.error(`Could not sync Dodo subscription ${id}.`, error);
			}
		}

		return null;
	}
});
