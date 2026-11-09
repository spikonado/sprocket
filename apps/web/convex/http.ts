import { httpRouter } from 'convex/server';
import { internal } from '@convex/_generated/api';
import { env, httpAction } from '@convex/_generated/server';
import { parseAgentcardWebhook, verifyAgentcardSignature } from '@convex/lib/payments/agentcard';

const http = httpRouter();

http.route({
	path: '/dodopayments-webhook',
	method: 'POST',
	handler: httpAction(async (ctx, request) => {
		const result = await ctx.runAction(internal.dodo.handleWebhook, {
			body: await request.text(),
			headers: Object.fromEntries(request.headers.entries())
		});

		return result === 'invalid'
			? new Response('Webhook verification failed.', { status: 401 })
			: new Response(null, { status: 204 });
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
