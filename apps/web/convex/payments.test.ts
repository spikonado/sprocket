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

type MockAuthorization = {
	status: string;
	execution_mode?: string;
	approvalUrl?: string | null;
	replay_attempted?: boolean;
};

type MockAuthorizations = { create?: MockAuthorization; read?: MockAuthorization };

const awaitingApproval: MockAuthorization = {
	status: 'awaiting_approval',
	approvalUrl: 'https://vault.agentcard.sh/authorize?id=cauth_1'
};

function agentcardApi(authorizations: MockAuthorizations = {}) {
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
				amount: 2306,
				currency: 'usd',
				poll_interval_ms: 2000,
				...(authorizations.create ?? awaitingApproval)
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

		if (url.endsWith('/api/v2/checkout/authorizations/cauth_1/cancel')) {
			return Response.json({ id: 'cauth_1', status: 'declined' });
		}

		if (url.endsWith('/api/v2/checkout/authorizations/cauth_1') && authorizations.read) {
			return Response.json({
				id: 'cauth_1',
				amount: 2306,
				currency: 'usd',
				...authorizations.read
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
	attemptId: 'attempt-1',
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
		expect(await t.action(api.payments.checkoutCreate, { ...auth, ...checkout })).toEqual(created);

		const createCalls = fetchMock.mock.calls.filter(
			([url, init]) =>
				String(url).endsWith('/api/v2/checkout/authorizations') && init?.method === 'POST'
		);

		expect(createCalls).toHaveLength(1);
		expect(JSON.parse(String(createCalls[0]?.[1]?.body))).toMatchObject({
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

		if (created.status !== 'awaiting_approval') throw new Error('Expected a purchase.');

		await expect(
			t.action(api.payments.reportOrder, {
				...auth,
				purchaseId: created.purchaseId,
				orderNumber: '112-7',
				orderLink: 'javascript:alert(1)'
			})
		).rejects.toThrow('orderLink must be an https URL.');

		await t.action(api.payments.reportOrder, {
			...auth,
			purchaseId: created.purchaseId,
			orderNumber: '112-7',
			orderLink: 'https://shop.example.com/orders/112-7',
			trackingLink: 'https://track.example.com/1Z'
		});

		expect(await asUser.query(api.payments.listMyPurchases, {})).toEqual([
			expect.objectContaining({
				merchant: 'shop.example.com',
				amount: 2306,
				currency: 'usd',
				status: 'settled',
				orderNumber: '112-7',
				orderLink: 'https://shop.example.com/orders/112-7',
				trackingLink: 'https://track.example.com/1Z'
			})
		]);
	});

	it('records a purchase Agentcard pays without asking and shows its approval card only once it needs one', async () => {
		const t = initConvexTest();

		const authorizations: MockAuthorizations = {
			create: { status: 'awaiting_approval', execution_mode: 'autopilot', approvalUrl: null }
		};

		const fetchMock = agentcardApi(authorizations);
		const { asUser, threadId, auth } = await startRun(t, 'buyer');
		await t.mutation(internal.payments.saveAgentcardUser, {
			userId: 'buyer',
			agentcardUserId: 'usr_buyer'
		});

		const created = await t.action(api.payments.checkoutCreate, { ...auth, ...checkout });

		if (created.status !== 'awaiting_approval') throw new Error('Expected a purchase.');

		expect(await t.action(api.payments.checkoutCreate, { ...auth, ...checkout })).toEqual(created);
		expect(
			fetchMock.mock.calls.filter(
				([url, init]) =>
					String(url).endsWith('/api/v2/checkout/authorizations') && init?.method === 'POST'
			)
		).toHaveLength(1);
		expect(await asUser.query(api.payments.pendingThreadApprovals, { threadId })).toEqual([]);
		expect(await asUser.query(api.payments.listMyPurchases, {})).toEqual([
			expect.objectContaining({ status: 'awaiting_approval' })
		]);

		authorizations.read = { ...awaitingApproval, execution_mode: 'user_approval' };
		await t.action(api.payments.checkoutPoll, { ...auth, purchaseId: created.purchaseId });

		expect(await asUser.query(api.payments.pendingThreadApprovals, { threadId })).toEqual([
			expect.objectContaining({ approvalUrl: awaitingApproval.approvalUrl })
		]);
	});

	it('records the status Agentcard creates a purchase with', async () => {
		const t = initConvexTest();
		agentcardApi({ create: { status: 'approved', execution_mode: 'autopilot' } });
		const { asUser, auth } = await startRun(t, 'buyer');
		await t.mutation(internal.payments.saveAgentcardUser, {
			userId: 'buyer',
			agentcardUserId: 'usr_buyer'
		});

		expect(await t.action(api.payments.checkoutCreate, { ...auth, ...checkout })).toMatchObject({
			status: 'awaiting_approval'
		});
		expect(await asUser.query(api.payments.listMyPurchases, {})).toEqual([
			expect.objectContaining({ status: 'approved' })
		]);
	});

	it('cancels a purchase once and keeps it cancelled', async () => {
		const t = initConvexTest();
		const fetchMock = agentcardApi();
		const { asUser, auth } = await startRun(t, 'buyer');
		await t.mutation(internal.payments.saveAgentcardUser, {
			userId: 'buyer',
			agentcardUserId: 'usr_buyer'
		});

		const created = await t.action(api.payments.checkoutCreate, { ...auth, ...checkout });

		if (created.status !== 'awaiting_approval') throw new Error('Expected a purchase.');

		const cancel = { ...auth, purchaseId: created.purchaseId };
		const cancelled = { status: 'cancelled' };

		expect(await t.action(api.payments.checkoutCancel, cancel)).toEqual(cancelled);
		await t.mutation(internal.payments.updatePurchase, {
			authorizationId: 'cauth_1',
			status: 'declined'
		});
		expect(await t.action(api.payments.checkoutCancel, cancel)).toEqual(cancelled);

		expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/cancel'))).toHaveLength(1);
		expect(await asUser.query(api.payments.listMyPurchases, {})).toEqual([
			expect.objectContaining({ status: 'cancelled' })
		]);
	});

	it('reports an expiry after the device may have sent the card as an unknown outcome', async () => {
		const t = initConvexTest();
		const authorization = { status: 'expired', replay_attempted: false };
		agentcardApi({ read: authorization });
		const { auth } = await startRun(t, 'buyer');
		await t.mutation(internal.payments.saveAgentcardUser, {
			userId: 'buyer',
			agentcardUserId: 'usr_buyer'
		});

		const created = await t.action(api.payments.checkoutCreate, { ...auth, ...checkout });

		if (created.status !== 'awaiting_approval') throw new Error('Expected a purchase.');

		const purchase = { ...auth, purchaseId: created.purchaseId };

		expect(await t.action(api.payments.checkoutPoll, purchase)).toMatchObject({
			status: 'expired'
		});
		expect(await t.action(api.payments.checkoutCancel, purchase)).toEqual({ status: 'expired' });

		authorization.replay_attempted = true;

		expect(await t.action(api.payments.checkoutPoll, purchase)).toMatchObject({
			status: 'outcome_unknown'
		});
		expect(await t.action(api.payments.checkoutCancel, purchase)).toEqual({
			status: 'outcome_unknown'
		});
	});

	it('hides a purchase whose payment the store rejected until a charge settles', async () => {
		const t = initConvexTest();
		agentcardApi();
		const { asUser, auth } = await startRun(t, 'buyer');
		await t.mutation(internal.payments.saveAgentcardUser, {
			userId: 'buyer',
			agentcardUserId: 'usr_buyer'
		});

		const created = await t.action(api.payments.checkoutCreate, { ...auth, ...checkout });

		if (created.status !== 'awaiting_approval') throw new Error('Expected a purchase.');

		await t.action(api.payments.reportOrder, {
			...auth,
			purchaseId: created.purchaseId,
			outcome: 'failed'
		});
		await t.mutation(internal.payments.updatePurchase, {
			authorizationId: 'cauth_1',
			status: 'approved'
		});

		expect(await asUser.query(api.payments.listMyPurchases, {})).toEqual([]);

		await t.mutation(internal.payments.updatePurchase, {
			authorizationId: 'cauth_1',
			status: 'settled'
		});

		expect(await asUser.query(api.payments.listMyPurchases, {})).toEqual([
			expect.objectContaining({ status: 'settled' })
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
