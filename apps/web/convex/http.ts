import { httpRouter } from 'convex/server';
import { internal } from '@convex/_generated/api';
import { httpAction } from '@convex/_generated/server';

const http = httpRouter();

// Acknowledge only after the signed event is durably persisted; processing
// continues asynchronously from the ledger. Invalid signatures are rejected
// before persistence.
http.route({
	path: '/dodopayments-webhook',
	method: 'POST',
	handler: httpAction(async (ctx, request) => {
		const webhookId = request.headers.get('webhook-id');
		const webhookSignature = request.headers.get('webhook-signature');
		const webhookTimestamp = request.headers.get('webhook-timestamp');

		if (!webhookId || !webhookSignature || !webhookTimestamp) {
			return new Response('Missing webhook headers.', { status: 400 });
		}

		const body = await request.text();

		try {
			await ctx.runAction(internal.billingWebhook.ingest, {
				body,
				webhookId,
				webhookSignature,
				webhookTimestamp
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Webhook rejected.';

			// Verification and shape failures are client errors; transient
			// storage failures surface as 500 so the provider retries.
			const status = /signature|timestamp|size limit|event type|secret/i.test(message) ? 401 : 500;

			return new Response(
				status === 401 ? 'Webhook verification failed.' : 'Webhook ingestion failed.',
				{ status }
			);
		}

		return new Response(JSON.stringify({ received: true }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' }
		});
	})
});

export default http;
