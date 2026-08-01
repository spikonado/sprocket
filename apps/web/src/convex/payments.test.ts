import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import {
	createQueuedRun,
	initConvexTest,
	seedOwnedThread,
	type ConvexTestInstance
} from '@convex/test.setup';

async function startRun(t: ConvexTestInstance, subject: string) {
	const { asUser, threadId } = await seedOwnedThread(t, subject);
	const executionSecret = `payment-secret-${subject}`;
	const created = await createQueuedRun(
		asUser,
		threadId,
		`payment-submission-${subject}-${Math.random()}`,
		executionSecret
	);
	const claimId = `payment-claim-${subject}`;
	await t.mutation(api.agentRuntime.start, {
		runId: created.runId,
		claimId,
		executionSecret
	});
	return {
		asUser: t.withIdentity({ subject, email: `${subject}@example.com` }),
		userEmail: `${subject}@example.com`,
		runId: created.runId,
		claimId,
		executionSecret
	};
}

function jsonResponse(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

function createArgs(run: Awaited<ReturnType<typeof startRun>>) {
	return {
		merchantName: 'Example Shop',
		merchantUrl: 'https://shop.example',
		countryCode: 'US',
		totalAmount: '42.50',
		currency: 'USD',
		description: 'Test order',
		items: [{ description: 'Widget', unitPrice: '21.25', quantity: 2 }],
		userEmail: run.userEmail,
		runId: run.runId,
		claimId: run.claimId,
		executionSecret: run.executionSecret
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env.PRAVA_SECRET_KEY;
	delete process.env.PRAVA_BACKEND_URL;
});

describe('payments', () => {
	it('maps a Prava purchase session and stores only non-sensitive purchase state', async () => {
		process.env.PRAVA_SECRET_KEY = 'sk_test_secret';
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse({
				session_id: 'prava-session-1',
				session_token: 'session-token',
				expires_at: '2026-08-01T10:15:00Z',
				iframe_url: 'https://sandbox.api.prava.space/iframe/1',
				order_id: 'order-1'
			})
		);
		vi.stubGlobal('fetch', fetchMock);
		const t = initConvexTest();
		const run = await startRun(t, 'user_alice');

		const result = await run.asUser.action(api.payments.createPurchaseSession, createArgs(run));

		expect(result).toEqual({
			purchaseId: expect.any(String),
			iframeUrl: 'https://sandbox.api.prava.space/iframe/1',
			expiresAt: '2026-08-01T10:15:00Z'
		});
		const request = fetchMock.mock.calls[0];
		expect(request[0]).toBe('https://sandbox.api.prava.space/v1/sessions');
		expect(request[1]?.headers).toMatchObject({
			Authorization: 'Bearer sk_test_secret'
		});
		expect(JSON.parse(String(request[1]?.body))).toMatchObject({
			user_id: 'user_alice',
			user_email: 'user_alice@example.com',
			total_amount: '42.50',
			purchase_context: [
				{
					merchant_details: {
						name: 'Example Shop',
						url: 'https://shop.example',
						country_code_iso2: 'US'
					},
					product_details: [{ description: 'Widget', unit_price: '21.25', quantity: 2 }],
					effective_until_minutes: 15
				}
			]
		});
		const stored = await t.run(async (ctx) => ctx.db.get(result.purchaseId as Id<'purchases'>));
		expect(stored).toMatchObject({
			userId: 'user_alice',
			runId: run.runId,
			pravaSessionId: 'prava-session-1',
			status: 'awaiting_passkey'
		});
		expect(stored).not.toHaveProperty('session_token');
		expect(stored).not.toHaveProperty('token');
	});

	it('returns pending then ready credentials without persisting credentials', async () => {
		process.env.PRAVA_SECRET_KEY = 'sk_test_secret';
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({
					session_id: 'prava-session-2',
					session_token: 'session-token',
					expires_at: '2026-08-01T10:15:00Z',
					iframe_url: 'https://sandbox.api.prava.space/iframe/2',
					order_id: 'order-2'
				})
			)
			.mockResolvedValueOnce(
				jsonResponse({ session_id: 'prava-session-2', status: 'pending', transactions: [] })
			)
			.mockResolvedValueOnce(
				jsonResponse({
					session_id: 'prava-session-2',
					status: 'awaiting_result',
					transactions: [
						{
							txn_id: 'txn-1',
							status: 'READY',
							line_items: [
								{
									txn_ref_id: 'ref-1',
									merchant_name: 'Example Shop',
									merchant_url: 'https://shop.example',
									total_amount: '42.50',
									status: 'READY',
									token: '4111111111111111',
									dynamic_cvv: '123',
									expiry_month: '12',
									expiry_year: '2030'
								}
							]
						}
					]
				})
			);
		vi.stubGlobal('fetch', fetchMock);
		const t = initConvexTest();
		const run = await startRun(t, 'user_alice');
		const created = await run.asUser.action(api.payments.createPurchaseSession, createArgs(run));
		const credentialArgs = {
			purchaseId: created.purchaseId as Id<'purchases'>,
			runId: run.runId,
			claimId: run.claimId,
			executionSecret: run.executionSecret
		};

		await expect(
			run.asUser.action(api.payments.getPaymentCredential, credentialArgs)
		).resolves.toEqual({ ready: false, status: 'pending' });
		await expect(
			run.asUser.action(api.payments.getPaymentCredential, credentialArgs)
		).resolves.toEqual({
			ready: true,
			token: '4111111111111111',
			dynamicCvv: '123',
			expiryMonth: '12',
			expiryYear: '2030',
			txnRefId: 'ref-1'
		});

		const stored = await t.run(async (ctx) => ctx.db.get(credentialArgs.purchaseId));
		expect(stored?.status).toBe('awaiting_result');
		expect(stored).not.toHaveProperty('token');
		expect(stored).not.toHaveProperty('dynamicCvv');
		expect(stored).not.toHaveProperty('expiryMonth');
		expect(stored).not.toHaveProperty('expiryYear');
	});

	it('reports an outcome only once', async () => {
		process.env.PRAVA_SECRET_KEY = 'sk_test_secret';
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({
					session_id: 'prava-session-3',
					session_token: 'session-token',
					expires_at: '2026-08-01T10:15:00Z',
					iframe_url: 'https://sandbox.api.prava.space/iframe/3',
					order_id: 'order-3'
				})
			)
			.mockResolvedValueOnce(jsonResponse({ ok: true }));
		vi.stubGlobal('fetch', fetchMock);
		const t = initConvexTest();
		const run = await startRun(t, 'user_alice');
		const created = await run.asUser.action(api.payments.createPurchaseSession, createArgs(run));
		const reportArgs = {
			purchaseId: created.purchaseId as Id<'purchases'>,
			outcome: 'approved' as const,
			txnRefId: 'ref-3',
			runId: run.runId,
			claimId: run.claimId,
			executionSecret: run.executionSecret
		};

		await expect(run.asUser.action(api.payments.reportStatus, reportArgs)).resolves.toEqual({
			reported: true
		});
		await expect(run.asUser.action(api.payments.reportStatus, reportArgs)).resolves.toEqual({
			reported: true,
			alreadyReported: true
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const stored = await t.run(async (ctx) => ctx.db.get(reportArgs.purchaseId));
		expect(stored).toMatchObject({ status: 'spent', reportedAt: expect.any(Number) });
	});

	it('reports to Prava exactly once when reportStatus races', async () => {
		process.env.PRAVA_SECRET_KEY = 'sk_test_secret';
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({
					session_id: 'prava-session-race',
					session_token: 'session-token',
					expires_at: '2026-08-01T10:15:00Z',
					iframe_url: 'https://sandbox.api.prava.space/iframe/race',
					order_id: 'order-race'
				})
			)
			// The single Prava report-status call that should ever happen.
			.mockResolvedValueOnce(jsonResponse({ ok: true }));
		vi.stubGlobal('fetch', fetchMock);
		const t = initConvexTest();
		const run = await startRun(t, 'user_alice');
		const created = await run.asUser.action(api.payments.createPurchaseSession, createArgs(run));
		const reportArgs = {
			purchaseId: created.purchaseId as Id<'purchases'>,
			outcome: 'approved' as const,
			txnRefId: 'ref-race',
			runId: run.runId,
			claimId: run.claimId,
			executionSecret: run.executionSecret
		};

		const [first, second] = await Promise.all([
			run.asUser.action(api.payments.reportStatus, reportArgs),
			run.asUser.action(api.payments.reportStatus, reportArgs)
		]);

		expect(first).toEqual({ reported: true });
		expect(second).toEqual({ reported: true, alreadyReported: true });
		// One create + exactly one report-status call to Prava.
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const stored = await t.run(async (ctx) => ctx.db.get(reportArgs.purchaseId));
		expect(stored).toMatchObject({
			status: 'spent',
			reportedAt: expect.any(Number)
		});
		expect(stored?.reportingStartedAt).toBeUndefined();
	});

	it('rejects access to another user’s purchase before calling Prava', async () => {
		process.env.PRAVA_SECRET_KEY = 'sk_test_secret';
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse({
				session_id: 'prava-session-4',
				session_token: 'session-token',
				expires_at: '2026-08-01T10:15:00Z',
				iframe_url: 'https://sandbox.api.prava.space/iframe/4',
				order_id: 'order-4'
			})
		);
		vi.stubGlobal('fetch', fetchMock);
		const t = initConvexTest();
		const alice = await startRun(t, 'user_alice');
		const created = await alice.asUser.action(
			api.payments.createPurchaseSession,
			createArgs(alice)
		);
		const bob = await startRun(t, 'user_bob');

		await expect(
			bob.asUser.action(api.payments.getPaymentCredential, {
				purchaseId: created.purchaseId as Id<'purchases'>,
				runId: bob.runId,
				claimId: bob.claimId,
				executionSecret: bob.executionSecret
			})
		).rejects.toThrow('Purchase not found.');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
