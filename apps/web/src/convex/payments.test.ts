import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '@convex/_generated/api';
import {
	createQueuedRun,
	initConvexTest,
	seedOwnedThread,
	type ConvexTestInstance
} from '@convex/test.setup';

async function startRun(t: ConvexTestInstance, subject: string) {
	const { asUser, threadId } = await seedOwnedThread(t, subject);
	const executionSecret = `mandate-secret-${subject}`;
	const created = await createQueuedRun(
		asUser,
		threadId,
		`mandate-${subject}-${Math.random()}`,
		executionSecret
	);
	const claimId = `mandate-claim-${subject}`;
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

function auth(run: Awaited<ReturnType<typeof startRun>>) {
	return { runId: run.runId, claimId: run.claimId, executionSecret: run.executionSecret };
}

function setupArgs(run: Awaited<ReturnType<typeof startRun>>) {
	return {
		merchantName: 'Example Shop',
		merchantUrl: 'https://shop.example',
		countryCode: 'US',
		amountCap: '120.00',
		currency: 'USD',
		frequency: 'monthly' as const,
		scope: 'listed' as const,
		description: 'Monthly budget',
		userEmail: run.userEmail,
		...auth(run)
	};
}

async function createApprovedMandate(
	t: ConvexTestInstance,
	run: Awaited<ReturnType<typeof startRun>>,
	mandates: unknown[] = [
		{
			id: 'mdt_1',
			status: 'active',
			merchantName: 'Example Shop',
			approvedAmount: '120.00',
			remaining: '120.00',
			currency: 'USD',
			validUntil: '2027-08-01T00:00:00Z',
			renewsAt: '2026-09-01T00:00:00Z'
		}
	]
) {
	const fetchMock = vi
		.fn()
		// mandateSetup → create session
		.mockResolvedValueOnce(
			jsonResponse({
				session_id: 'prava-session-1',
				iframe_url: 'https://pay.prava.space/approve/1',
				session_token: 'session-token-1',
				expires_at: '2026-08-01T10:15:00Z'
			})
		)
		// resolvePravaMandate → list
		.mockResolvedValueOnce(jsonResponse({ mandates }));
	vi.stubGlobal('fetch', fetchMock);

	const setup = await run.asUser.action(api.payments.mandateSetup, setupArgs(run));
	return { setup, fetchMock };
}

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env.PRAVA_SECRET_KEY;
	delete process.env.PRAVA_BACKEND_URL;
});

describe('payments mandates', () => {
	it('creates a mandate setup session and stores non-sensitive state', async () => {
		process.env.PRAVA_SECRET_KEY = 'sk_test_secret';
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse({
				session_id: 'prava-session-1',
				iframe_url: 'https://pay.prava.space/approve/1',
				session_token: 'session-token-1',
				expires_at: '2026-08-01T10:15:00Z'
			})
		);
		vi.stubGlobal('fetch', fetchMock);
		const t = initConvexTest();
		const run = await startRun(t, 'user_alice');

		const result = await run.asUser.action(api.payments.mandateSetup, setupArgs(run));

		expect(result).toEqual({
			mandateId: expect.any(String),
			approvalUrl: 'https://pay.prava.space/approve/1',
			sessionToken: 'session-token-1',
			expiresAt: '2026-08-01T10:15:00Z'
		});
		const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
		expect(body).toMatchObject({
			user_id: 'user_alice',
			user_email: 'user_alice@example.com',
			total_amount: '120.00',
			mandate_setup: {
				intent: 'mandate_setup',
				recurring_frequency: 'monthly',
				merchant_scope: 'listed'
			}
		});
		const stored = await t.run(async (ctx) => ctx.db.get(result.mandateId));
		expect(stored).toMatchObject({
			userId: 'user_alice',
			status: 'pending',
			approvalUrl: 'https://pay.prava.space/approve/1'
		});
		expect(stored).not.toHaveProperty('session_token');
	});

	it('syncs a pending mandate to active once the owner approves', async () => {
		process.env.PRAVA_SECRET_KEY = 'sk_test_secret';
		const t = initConvexTest();
		const run = await startRun(t, 'user_alice');
		const { setup } = await createApprovedMandate(t, run);
		const status = await run.asUser.action(api.payments.mandateStatus, {
			mandateId: setup.mandateId,
			...auth(run)
		});

		expect(status.status).toBe('active');
		expect(status.pravaMandateId).toBe('mdt_1');
		expect(status.remaining).toBe('120.00');
	});

	it('charges an active mandate and stores the charge without persisting credentials', async () => {
		process.env.PRAVA_SECRET_KEY = 'sk_test_secret';
		const t = initConvexTest();
		const run = await startRun(t, 'user_alice');
		const { setup, fetchMock } = await createApprovedMandate(t, run);

		// charge
		fetchMock.mockResolvedValueOnce(
			jsonResponse({
				transactionId: 'txn_9',
				status: 'awaiting_result',
				credentials: {
					token: '4111111111111111',
					dynamicCvv: '123',
					expiryMonth: '12',
					expiryYear: '2030'
				}
			})
		);

		const charge = await run.asUser.action(api.payments.mandateCharge, {
			mandateId: setup.mandateId,
			amount: '40.00',
			currency: 'USD',
			description: 'Order 8842',
			reference: 'order-8842',
			...auth(run)
		});

		expect(charge).toMatchObject({
			transactionId: 'txn_9',
			token: '4111111111111111',
			dynamicCvv: '123'
		});
		const chargeBody = JSON.parse(String(fetchMock.mock.calls.at(-1)![1]?.body));
		expect(chargeBody).toEqual({ amount: '40.00', reference: 'order-8842' });

		const stored = await t.run(async (ctx) => ctx.db.get(charge.chargeId));
		expect(stored).toMatchObject({
			userId: 'user_alice',
			pravaTransactionId: 'txn_9',
			amount: '40.00',
			status: 'awaiting_result'
		});
		expect(stored).not.toHaveProperty('token');
		expect(stored).not.toHaveProperty('dynamicCvv');
	});

	it('reports a charge outcome only once', async () => {
		process.env.PRAVA_SECRET_KEY = 'sk_test_secret';
		const t = initConvexTest();
		const run = await startRun(t, 'user_alice');
		const { setup, fetchMock } = await createApprovedMandate(t, run);
		fetchMock.mockResolvedValueOnce(
			jsonResponse({
				transactionId: 'txn_9',
				status: 'awaiting_result',
				credentials: { token: 't', dynamicCvv: 'c', expiryMonth: '12', expiryYear: '2030' }
			})
		);
		const charge = await run.asUser.action(api.payments.mandateCharge, {
			mandateId: setup.mandateId,
			amount: '40.00',
			currency: 'USD',
			description: 'Order 8842',
			...auth(run)
		});

		fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'completed', mandateStatus: 'active' }));
		const first = await run.asUser.action(api.payments.mandateReport, {
			chargeId: charge.chargeId,
			outcome: 'approved',
			...auth(run)
		});
		const second = await run.asUser.action(api.payments.mandateReport, {
			chargeId: charge.chargeId,
			outcome: 'approved',
			...auth(run)
		});

		expect(first).toEqual({ reported: true });
		expect(second).toEqual({ reported: true, alreadyReported: true });
		const reportCall = fetchMock.mock.calls.at(-1)!;
		expect(String(reportCall[0])).toBe(
			'https://sandbox.api.prava.space/v1/mandates/mdt_1/charges/txn_9/report'
		);
		expect(JSON.parse(String(reportCall[1]?.body))).toMatchObject({
			txn_status: 'APPROVED',
			txn_type: 'PURCHASE'
		});
	});

	it('rejects charging another user’s mandate before calling Prava', async () => {
		process.env.PRAVA_SECRET_KEY = 'sk_test_secret';
		const t = initConvexTest();
		const alice = await startRun(t, 'user_alice');
		const bob = await startRun(t, 'user_bob');
		const { setup, fetchMock } = await createApprovedMandate(t, alice);
		fetchMock.mockClear();

		await expect(
			bob.asUser.action(api.payments.mandateCharge, {
				mandateId: setup.mandateId,
				amount: '40.00',
				currency: 'USD',
				description: 'Nope',
				...auth(bob)
			})
		).rejects.toThrow('Mandate not found');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('re-sends the report to Prava when retrying an abandoned stale claim', async () => {
		process.env.PRAVA_SECRET_KEY = 'sk_test_secret';
		const t = initConvexTest();
		const run = await startRun(t, 'user_alice');
		const { setup, fetchMock } = await createApprovedMandate(t, run);
		fetchMock.mockResolvedValueOnce(
			jsonResponse({
				transactionId: 'txn_9',
				status: 'awaiting_result',
				credentials: { token: 't', dynamicCvv: 'c', expiryMonth: '12', expiryYear: '2030' }
			})
		);
		const charge = await run.asUser.action(api.payments.mandateCharge, {
			mandateId: setup.mandateId,
			amount: '40.00',
			currency: 'USD',
			description: 'Order 8842',
			...auth(run)
		});

		// Simulate a crash after claiming the report but before the Prava POST:
		// an old reportingStartedAt with no reportedAt.
		const stale = Date.now() - 120_000;
		await t.run(async (ctx) =>
			ctx.db.patch(charge.chargeId, { reportingStartedAt: stale, reportOutcome: 'approved' })
		);
		fetchMock.mockClear();
		fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'completed', mandateStatus: 'active' }));

		const result = await run.asUser.action(api.payments.mandateReport, {
			chargeId: charge.chargeId,
			outcome: 'approved',
			...auth(run)
		});

		expect(result).toEqual({ reported: true });
		// The retry must actually deliver the outcome to Prava, not just finalize locally.
		const reportCall = fetchMock.mock.calls.at(-1)!;
		expect(String(reportCall[0])).toBe(
			'https://sandbox.api.prava.space/v1/mandates/mdt_1/charges/txn_9/report'
		);
		expect(JSON.parse(String(reportCall[1]?.body))).toMatchObject({
			txn_status: 'APPROVED',
			txn_type: 'PURCHASE'
		});
		const stored = await t.run(async (ctx) => ctx.db.get(charge.chargeId));
		expect(stored).toMatchObject({ status: 'completed', reportedAt: expect.any(Number) });
	});

	it('reports an in-flight claim as not-yet-reported instead of claiming success', async () => {
		process.env.PRAVA_SECRET_KEY = 'sk_test_secret';
		const t = initConvexTest();
		const run = await startRun(t, 'user_alice');
		const { setup, fetchMock } = await createApprovedMandate(t, run);
		fetchMock.mockResolvedValueOnce(
			jsonResponse({
				transactionId: 'txn_9',
				status: 'awaiting_result',
				credentials: { token: 't', dynamicCvv: 'c', expiryMonth: '12', expiryYear: '2030' }
			})
		);
		const charge = await run.asUser.action(api.payments.mandateCharge, {
			mandateId: setup.mandateId,
			amount: '40.00',
			currency: 'USD',
			description: 'Order 8842',
			...auth(run)
		});

		// A fresh (non-stale) claim held by a competing caller, no report completed.
		await t.run(async (ctx) =>
			ctx.db.patch(charge.chargeId, { reportingStartedAt: Date.now(), reportOutcome: 'approved' })
		);
		fetchMock.mockClear();

		const result = await run.asUser.action(api.payments.mandateReport, {
			chargeId: charge.chargeId,
			outcome: 'approved',
			...auth(run)
		});

		expect(result).toEqual({ reported: false, inFlight: true });
		// No report request issued, and the charge stays unreported.
		expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/report'))).toBe(false);
		const stored = await t.run(async (ctx) => ctx.db.get(charge.chargeId));
		expect(stored?.reportedAt).toBeUndefined();
	});

	it('rejects a recurring frequency for an any-merchant mandate', async () => {
		process.env.PRAVA_SECRET_KEY = 'sk_test_secret';
		const t = initConvexTest();
		const run = await startRun(t, 'user_alice');

		await expect(
			run.asUser.action(api.payments.mandateSetup, {
				scope: 'any',
				frequency: 'monthly',
				amountCap: '200.00',
				currency: 'USD',
				description: 'Weekly groceries',
				userEmail: run.userEmail,
				...auth(run)
			})
		).rejects.toThrow(/one-time/);
	});

	it('rejects charging when multiple approved mandates match instead of picking one', async () => {
		process.env.PRAVA_SECRET_KEY = 'sk_test_secret';
		const t = initConvexTest();
		const run = await startRun(t, 'user_alice');
		// Two approvals with the same merchant + amount: resolution must not guess.
		const { setup, fetchMock } = await createApprovedMandate(t, run, [
			{
				id: 'mdt_old',
				status: 'active',
				merchantName: 'Example Shop',
				approvedAmount: '120.00',
				remaining: '120.00',
				currency: 'USD'
			},
			{
				id: 'mdt_new',
				status: 'active',
				merchantName: 'Example Shop',
				approvedAmount: '120.00',
				remaining: '120.00',
				currency: 'USD'
			}
		]);
		fetchMock.mockClear();

		await expect(
			run.asUser.action(api.payments.mandateCharge, {
				mandateId: setup.mandateId,
				amount: '40.00',
				currency: 'USD',
				description: 'Order 8842',
				...auth(run)
			})
		).rejects.toThrow(/Multiple approved mandates/);
		// No charge POST should have been issued against either mandate.
		expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/charge'))).toBe(false);
	});

	it('lists only the calling user’s mandates via the user-facing action', async () => {
		process.env.PRAVA_SECRET_KEY = 'sk_test_secret';
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse({
				mandates: [
					{
						id: 'mdt_1',
						status: 'active',
						merchantName: 'Example Shop',
						approvedAmount: '120.00',
						remaining: '120.00',
						currency: 'USD'
					}
				]
			})
		);
		vi.stubGlobal('fetch', fetchMock);
		const t = initConvexTest();
		const alice = await startRun(t, 'user_alice');

		const result = await alice.asUser.action(api.payments.listMyMandates, {});

		expect(result.mandates).toHaveLength(1);
		expect(result.mandates[0]).toMatchObject({ pravaMandateId: 'mdt_1', status: 'active' });
		// Scoped to the caller, standing-only.
		expect(String(fetchMock.mock.calls[0][0])).toBe(
			'https://sandbox.api.prava.space/v1/mandates?customer_id=user_alice&standing_only=true'
		);
	});

	it('rejects the user-facing lifecycle action on another user’s mandate', async () => {
		process.env.PRAVA_SECRET_KEY = 'sk_test_secret';
		const t = initConvexTest();
		const alice = await startRun(t, 'user_alice');
		const bob = await startRun(t, 'user_bob');
		const { setup, fetchMock } = await createApprovedMandate(t, alice);
		fetchMock.mockClear();

		await expect(
			bob.asUser.action(api.payments.setMyMandateLifecycle, {
				mandateId: setup.mandateId,
				action: 'pause'
			})
		).rejects.toThrow('Mandate not found');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('pauses an owned mandate via the lifecycle action', async () => {
		process.env.PRAVA_SECRET_KEY = 'sk_test_secret';
		const t = initConvexTest();
		const alice = await startRun(t, 'user_alice');
		const fetchMock = vi
			.fn()
			// mandateSetup → create session
			.mockResolvedValueOnce(
				jsonResponse({
					session_id: 'prava-session-1',
					iframe_url: 'https://pay.prava.space/approve/1',
					session_token: 'session-token-1',
					expires_at: '2026-08-01T10:15:00Z'
				})
			)
			// mandateStatus → resolve list (approves the mandate)
			.mockResolvedValueOnce(
				jsonResponse({
					mandates: [
						{
							id: 'mdt_1',
							status: 'active',
							merchantName: 'Example Shop',
							approvedAmount: '120.00',
							remaining: '120.00',
							currency: 'USD'
						}
					]
				})
			);
		vi.stubGlobal('fetch', fetchMock);
		const setup = await alice.asUser.action(api.payments.mandateSetup, setupArgs(alice));
		await alice.asUser.action(api.payments.mandateStatus, {
			mandateId: setup.mandateId,
			...auth(alice)
		});
		fetchMock.mockClear();
		fetchMock.mockResolvedValueOnce(
			jsonResponse({ id: 'mdt_1', status: 'paused', remaining: '120.00' })
		);

		const result = await alice.asUser.action(api.payments.setMyMandateLifecycle, {
			mandateId: setup.mandateId,
			action: 'pause'
		});

		expect(result.status).toBe('paused');
		expect(String(fetchMock.mock.calls.at(-1)![0])).toBe(
			'https://sandbox.api.prava.space/v1/mandates/mdt_1/pause'
		);
		expect(fetchMock.mock.calls.at(-1)![1]?.method).toBe('POST');
	});
});
