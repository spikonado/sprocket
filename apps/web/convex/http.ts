import { httpRouter } from 'convex/server';
import { internal } from '@convex/_generated/api';
import { env, httpAction } from '@convex/_generated/server';
import { parseAgentcardWebhook, verifyAgentcardSignature } from '@convex/lib/payments/agentcard';

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

http.route({
	path: '/agentcard-webhook',
	method: 'POST',
	handler: httpAction(async (ctx, request) => {
		const secret = env.AGENTCARD_WEBHOOK_SECRET?.trim();
		const signature = request.headers.get('AgentCard-Signature');
		const body = await request.text();

		if (!secret || !signature || !(await verifyAgentcardSignature(secret, signature, body))) {
			return new Response('Webhook verification failed.', { status: 401 });
		}

		const event = parseAgentcardWebhook(body);

		if (event?.kind === 'session_linked') {
			await ctx.runAction(internal.payments.linkVaultSession, {
				vaultSessionId: event.vaultSessionId
			});
		} else if (event) {
			await ctx.runMutation(internal.payments.updatePurchase, {
				authorizationId: event.authorizationId,
				status: event.status
			});
		}

		return new Response(null, { status: 204 });
	})
});

export default http;
