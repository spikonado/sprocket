import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, internal } from '@convex/_generated/api';
import {
	createQueuedRun,
	initConvexTest,
	seedOwnedThread,
	type ConvexTestInstance
} from '@convex/test.setup';

const stripeTokens = {
	url: 'https://api.stripe.com/v1/tokens',
	method: 'POST',
	headers: { 'content-type': 'application/x-www-form-urlencoded' },
	body: 'card[number]=4242424242424242'
};

function agentcardApi() {
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);

		if (url.endsWith('/api/v2/oauth/token')) {
			return Response.json({ access_token: 'org-token', expires_in: 3600 });
		}

		if (url.includes('/api/v2/checkout/recognizers')) {
			return Response.json([
				{
					psp: 'stripe',
					hosts: ['^api\\.stripe\\.com$'],
					match: 'api\\.stripe\\.com/v1/(payment_methods|tokens)'
				}
			]);
		}

		if (url.endsWith('/api/v2/checkout/authorizations') && init?.method === 'POST') {
			return Response.json({
				id: 'cauth_1',
				status: 'awaiting_approval',
				amount: 2306,
				currency: 'usd',
				approvalUrl: 'https://vault.agentcard.sh/authorize?id=cauth_1',
				poll_interval_ms: 2000
			});
		}

		if (url.endsWith('/api/v2/vault_sessions/vs_1')) {
			return Response.json({
				id: 'vs_1',
				status: 'linked',
				user_id: 'usr_x',
				external_user_id: 'buyer'
			});
		}

		throw new Error(`Unexpected Agentcard call: ${url}`);
	});

	vi.stubGlobal('fetch', fetchMock);

	return fetchMock;
}

async function startRun(t: ConvexTestInstance, subject: string) {
	const { asUser, threadId } = await seedOwnedThread(t, subject);
	const executionSecret = `payments-secret-${subject}`;

	const { runId } = await createQueuedRun(
		t,
		asUser,
		threadId,
		`payments-${subject}`,
		executionSecret
	);

	const auth = { runId, claimId: `payments-claim-${subject}`, executionSecret };
	await t.mutation(api.agentRuntime.start, auth);

	return { asUser, threadId, auth };
}

const checkout = {
	checkoutOrigin: 'https://shop.example.com',
	amount: '23.06',
	currency: 'USD',
	psp: 'stripe',
	request: stripeTokens
};

describe('Agentcard payments', () => {
	beforeEach(() => {
		vi.stubEnv('AGENTCARD_CLIENT_ID', 'client');
		vi.stubEnv('AGENTCARD_CLIENT_SECRET', 'secret');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it('asks for a card until the Vault links the user', async () => {
		const t = initConvexTest();
		agentcardApi();
		const { auth } = await startRun(t, 'buyer');

		expect(await t.action(api.payments.checkoutCreate, { ...auth, ...checkout })).toEqual({
			status: 'card_required'
		});
	});

	it('creates a purchase for the caller and only moves its status forward', async () => {
		const t = initConvexTest();
		const fetchMock = agentcardApi();
		const { asUser, auth } = await startRun(t, 'buyer');
		await t.mutation(internal.payments.saveAgentcardUser, {
			userId: 'buyer',
			agentcardUserId: 'usr_buyer'
		});

		const created = await t.action(api.payments.checkoutCreate, { ...auth, ...checkout });

		expect(created).toMatchObject({ status: 'awaiting_approval', pollIntervalMs: 2000 });

		const createCall = fetchMock.mock.calls.find(
			([url, init]) =>
				String(url).endsWith('/api/v2/checkout/authorizations') && init?.method === 'POST'
		);

		expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
			user: 'usr_buyer',
			merchant: 'shop.example.com',
			checkout_origin: 'https://shop.example.com',
			amount: '23.06',
			currency: 'usd'
		});

		for (const status of ['settled', 'approved'] as const) {
			await t.mutation(internal.payments.updatePurchase, {
				authorizationId: 'cauth_1',
				status
			});
		}

		expect(await asUser.query(api.payments.listMyPurchases, {})).toEqual([
			expect.objectContaining({
				merchant: 'shop.example.com',
				amount: 2306,
				currency: 'usd',
				status: 'settled'
			})
		]);
	});

	it('refuses requests that are not recognized payment requests', async () => {
		const t = initConvexTest();
		agentcardApi();
		const { auth } = await startRun(t, 'buyer');

		await expect(
			t.action(api.payments.checkoutCreate, {
				...auth,
				...checkout,
				request: { ...stripeTokens, url: 'https://evil.example/?u=api.stripe.com/v1/tokens' }
			})
		).rejects.toThrow('not a recognized payment request');
	});

	it('links the Sprocket user named by a signed session_linked webhook', async () => {
		vi.stubEnv('AGENTCARD_WEBHOOK_SECRET', 'whsec');
		const t = initConvexTest();
		agentcardApi();

		const body = JSON.stringify({
			type: 'vault.session_linked',
			data: { vault_session_id: 'vs_1', user_id: 'usr_x' }
		});

		const now = Math.floor(Date.now() / 1000);

		const rejected = await t.fetch('/agentcard-webhook', {
			method: 'POST',
			headers: { 'AgentCard-Signature': `t=${now},v1=00` },
			body
		});

		expect(rejected.status).toBe(401);

		const key = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode('whsec'),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		);

		const digest = await crypto.subtle.sign(
			'HMAC',
			key,
			new TextEncoder().encode(`${now}.${body}`)
		);

		const signature = Buffer.from(digest).toString('hex');

		const accepted = await t.fetch('/agentcard-webhook', {
			method: 'POST',
			headers: { 'AgentCard-Signature': `t=${now},v1=${signature}` },
			body
		});

		expect(accepted.status).toBe(204);
		expect(await t.query(internal.payments.agentcardUserId, { userId: 'buyer' })).toBe('usr_x');
	});
});
