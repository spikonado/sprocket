import { vi } from 'vitest';
import type { ConvexTestInstance } from './test.setup';

const WEBHOOK_SECRET = 'test_webhook_secret';

export type WebhookSubscriptionPayload = {
	payload_type: 'Subscription';
	subscription_id: string;
	product_id: string;
	status: string;
	previous_billing_date: Date;
	next_billing_date: Date;
	cancel_at_next_billing_date: boolean;
	payment_frequency_count: number;
	payment_frequency_interval: string;
	customer: { customer_id: string; email?: string; name?: string };
	metadata?: { userId?: string; tierId?: string; checkoutAttemptId?: string };
	scheduled_change?: {
		id: string;
		product_id: string;
		effective_at: Date;
	} | null;
};

export function subscriptionPayload(
	overrides: Partial<WebhookSubscriptionPayload> = {}
): WebhookSubscriptionPayload {
	const now = Date.now();

	return {
		payload_type: 'Subscription',
		cancel_at_next_billing_date: false,
		customer: { customer_id: 'cus_owner', email: 'owner@example.com', name: 'Owner' },
		metadata: { userId: 'owner', tierId: 'pro' },
		next_billing_date: new Date(now + 60_000),
		payment_frequency_count: 1,
		payment_frequency_interval: 'Month',
		previous_billing_date: new Date(now - 60_000),
		product_id: 'prod_pro',
		status: 'active',
		subscription_id: 'sub_owner',
		...overrides
	};
}

export async function sendSubscriptionWebhook(
	t: ConvexTestInstance,
	type: string,
	data: WebhookSubscriptionPayload,
	eventAt = Date.now()
) {
	const body = JSON.stringify({
		business_id: 'business',
		type,
		timestamp: new Date(eventAt),
		data
	});

	return await sendRawWebhook(t, body);
}

/** Sign and POST a raw body, optionally with a tampered signature. */
export async function sendRawWebhook(
	t: ConvexTestInstance,
	body: string,
	options: { webhookId?: string; tamperSignature?: boolean } = {}
) {
	vi.stubEnv('DODO_PAYMENTS_ENVIRONMENT', 'test_mode');
	vi.stubEnv(
		'DODO_PAYMENTS_WEBHOOK_SECRET',
		`whsec_${Buffer.from(WEBHOOK_SECRET).toString('base64url')}`
	);

	const webhookId = options.webhookId ?? `webhook_${crypto.randomUUID()}`;
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

	const signatureHeader = options.tamperSignature
		? 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
		: `v1,${btoa(String.fromCharCode(...new Uint8Array(signature)))}`;

	return await t.fetch('/dodopayments-webhook', {
		method: 'POST',
		body,
		headers: {
			'webhook-id': webhookId,
			'webhook-timestamp': timestamp,
			'webhook-signature': signatureHeader
		}
	});
}

export async function drainWebhookJobs(t: ConvexTestInstance): Promise<void> {
	for (let round = 0; round < 100; round++) {
		await vi.advanceTimersByTimeAsync(10);
		await t.finishInProgressScheduledFunctions();

		const pending = await t.run((ctx) =>
			ctx.db
				.query('dodoWebhookEvents')
				.withIndex('by_outcome_and_nextAttemptAt', (q) => q.eq('outcome', 'pending'))
				.collect()
		);

		if (pending.length === 0) return;
	}

	throw new Error('Webhook workers did not finish within the near-now drain window.');
}
