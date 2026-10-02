import type { Subscription } from '@dodopayments/convex';
import { vi } from 'vitest';
import type { ConvexTestInstance } from './test.setup';

const WEBHOOK_SECRET = 'test_webhook_secret';

export function subscriptionPayload(overrides: Partial<Subscription> = {}): Subscription {
	const now = Date.now();

	return {
		payload_type: 'Subscription',
		addons: [],
		billing: { city: null, country: 'US', state: null, street: null, zipcode: null },
		brand_id: 'brand',
		cancel_at_next_billing_date: false,
		created_at: new Date(now - 60_000),
		credit_entitlement_cart: [],
		currency: 'USD',
		customer: { customer_id: 'cus_owner', email: 'owner@example.com', name: 'Owner' },
		metadata: { userId: 'owner', tierId: 'pro' },
		meter_credit_entitlement_cart: [],
		meters: [],
		next_billing_date: new Date(now + 60_000),
		on_demand: false,
		payment_frequency_count: 1,
		payment_frequency_interval: 'Month',
		previous_billing_date: new Date(now - 60_000),
		product_id: 'prod_pro',
		quantity: 1,
		recurring_pre_tax_amount: 2_000,
		status: 'active',
		subscription_id: 'sub_owner',
		subscription_period_count: 1,
		subscription_period_interval: 'Month',
		tax_inclusive: false,
		trial_period_days: 0,
		...overrides
	};
}

export async function sendSubscriptionWebhook(
	t: ConvexTestInstance,
	type: string,
	data: Subscription,
	eventAt = Date.now()
) {
	vi.stubEnv('DODO_PAYMENTS_WEBHOOK_SECRET', btoa(WEBHOOK_SECRET));

	const body = JSON.stringify({
		business_id: 'business',
		type,
		timestamp: new Date(eventAt),
		data
	});

	const webhookId = `webhook_${crypto.randomUUID()}`;
	const timestamp = String(Math.floor(Date.now() / 1_000));
	const encoder = new TextEncoder();

	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(WEBHOOK_SECRET),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);

	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		encoder.encode(`${webhookId}.${timestamp}.${body}`)
	);

	return await t.fetch('/dodopayments-webhook', {
		method: 'POST',
		body,
		headers: {
			'webhook-id': webhookId,
			'webhook-timestamp': timestamp,
			'webhook-signature': `v1,${btoa(String.fromCharCode(...new Uint8Array(signature)))}`
		}
	});
}
