import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import type { JsonObject, JsonValue } from '@convex/lib/json';
import {
	createQueuedRun,
	initConvexTest,
	seedOwnedThread,
	type ConvexTestInstance
} from '@convex/test.setup';

async function startRun(
	t: ConvexTestInstance,
	subject: string,
	parentThreadId?: Id<'threadRecords'>
) {
	const { asUser, threadId } = await seedOwnedThread(t, subject);

	if (parentThreadId) {
		await t.run((ctx) => ctx.db.patch('threadRecords', threadId, { parentThreadId }));
	}

	// What the client's page-load bootstrap leaves behind: a users row whose
	// email ensureCurrentUser synced from the WorkOS identity.
	await t
		.withIdentity({ subject, email: `${subject}@example.com` })
		.mutation(api.billing.ensureMySubscription, {});
	const executionSecret = `mandate-secret-${subject}`;

	const created = await createQueuedRun(
		t,
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
		threadId,
		runId: created.runId,
		claimId,
		executionSecret
	};
}

function jsonResponse(value: JsonValue, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

function auth(run: Awaited<ReturnType<typeof startRun>>) {
	return { runId: run.runId, claimId: run.claimId, executionSecret: run.executionSecret };
}

async function settleMandateReport(
	t: ConvexTestInstance,
	run: Awaited<ReturnType<typeof startRun>>,
	args: {
		chargeId: import('@convex/_generated/dataModel').Id<'mandateCharges'>;
		outcome: 'approved' | 'declined';
	}
) {
	const startedFake = !vi.isFakeTimers();

	if (startedFake) vi.useFakeTimers();

	try {
		let result = await run.asUser.action(api.payments.mandateReport, {
			...args,
			...auth(run)
		});

		for (let attempt = 0; attempt < 12 && result.inFlight; attempt += 1) {
			await t.finishAllScheduledFunctions(() => {
				vi.advanceTimersByTime(25);
			});
			result = await run.asUser.action(api.payments.mandateReport, {
				...args,
				...auth(run)
			});
		}

		return result;
	} finally {
		if (startedFake) vi.useRealTimers();
	}
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
		...auth(run)
	};
}

type PravaMandateFixture = {
	id?: string;
	status?: string;
	merchantScope?: string;
	recurringFrequency?: string;
	merchantName?: string | null;
	merchantUrl?: string;
	countryCode?: string;
	approvedAmount?: string;
	remaining?: string | null;
	currency?: string;
	validUntil?: string | null;
	renewsAt?: string | null;
};

function liveListedMandate(overrides: PravaMandateFixture = {}): JsonObject {
	const mandate: JsonObject = {
		id: 'mdt_1',
		status: 'active',
		// Populated per Prava's current List Mandates response so the
		// scope/cadence comparisons in resolution are exercised.
		merchantScope: 'listed',
		recurringFrequency: 'monthly',
		merchantName: 'Example Shop',
		merchantUrl: 'https://shop.example',
		countryCode: 'US',
		approvedAmount: '120.00',
		remaining: '120.00',
		currency: 'USD',
		validUntil: '2027-08-01T00:00:00Z',
		renewsAt: '2026-09-01T00:00:00Z'
	};

	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) {
			delete mandate[key];
			continue;
		}

		mandate[key] = value;
	}

	return mandate;
}

async function createApprovedMandate(
	t: ConvexTestInstance,
	run: Awaited<ReturnType<typeof startRun>>,
	mandates: JsonValue[] = [liveListedMandate()]
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

beforeEach(() => {
	vi.stubEnv('PRAVA_BACKEND_URL', 'https://sandbox.api.prava.space');
	vi.stubEnv('PRAVA_SECRET_KEY', 'sk_test_secret');
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe('payments mandates', () => {
	it('enforces root-only payment actions for human-continued children at every depth', async () => {
		const t = initConvexTest();
		const root = await startRun(t, 'user_alice');
		const { setup, fetchMock } = await createApprovedMandate(t, root);

		const chargeId = await t.run((ctx) =>
			ctx.db.insert('mandateCharges', {
				mandateId: setup.mandateId,
				runId: root.runId,
				userId: 'user_alice',
				pravaTransactionId: 'root-transaction',
				amount: 100,
				currency: 'USD',
				description: 'Root purchase',
				status: 'awaiting_result',
				createdAt: Date.now(),
				updatedAt: Date.now()
			})
		);

		let parentThreadId = root.threadId;
		fetchMock.mockClear();

		for (let depth = 1; depth <= 2; depth += 1) {
			const child = await startRun(t, 'user_alice', parentThreadId);
			const caller = auth(child);
			await expect(t.action(api.payments.mandateSetup, setupArgs(child))).rejects.toThrow(
				/Payment tools are unavailable to subagents/
			);
			await expect(t.action(api.payments.mandateList, caller)).rejects.toThrow(
				/Payment tools are unavailable to subagents/
			);
			await expect(
				t.action(api.payments.mandateStatus, { ...caller, mandateId: setup.mandateId })
			).rejects.toThrow(/Payment tools are unavailable to subagents/);
			await expect(
				t.action(api.payments.mandateCharge, {
					...caller,
					mandateId: setup.mandateId,
					amount: '1.00',
					currency: 'USD',
					description: 'Child purchase'
				})
			).rejects.toThrow(/Payment tools are unavailable to subagents/);
			await expect(
				t.action(api.payments.mandateReport, { ...caller, chargeId, outcome: 'approved' })
			).rejects.toThrow(/Payment tools are unavailable to subagents/);
			parentThreadId = child.threadId;
		}

		expect(fetchMock).toHaveBeenCalledTimes(0);
	});

	it('creates a mandate setup session and stores non-sensitive state', async () => {
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

		// The Prava session token must not leak into the tool result (it goes to
		// the model transcript); the new-tab approval link doesn't need it.
		expect(result).toEqual({
			mandateId: expect.any(String),
			approvalUrl: 'https://pay.prava.space/approve/1',
			expiresAt: '2026-08-01T10:15:00Z'
		});
		const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
		expect(body).toMatchObject({
			user_id: 'user_alice',
			// The email comes from the caller's WorkOS identity, not tool args.
			user_email: 'user_alice@example.com',
			total_amount: '120.00',
			purchase_context: {
				custom: [
					{
						merchant_details: {
							name: 'Example Shop',
							url: 'https://shop.example',
							country_code_iso2: 'US'
						},
						product_details: [{ description: 'Monthly budget', unit_price: '120.00', quantity: 1 }]
					}
				]
			},
			mandate_setup: {
				intent: 'mandate_setup',
				recurring_frequency: 'monthly',
				merchant_scope: 'listed'
			}
		});
		const stored = await t.run(async (ctx) => ctx.db.get('mandates', result.mandateId));
		expect(stored).toMatchObject({
			userId: 'user_alice',
			status: 'pending',
			amountCap: 12_000,
			description: 'Monthly budget',
			approvalUrl: 'https://pay.prava.space/approve/1'
		});
		expect(stored).not.toHaveProperty('session_token');
	});

	it('reports a missing Prava backend URL instead of a fetch failure', async () => {
		vi.stubEnv('PRAVA_BACKEND_URL', undefined);
		const t = initConvexTest();
		const run = await startRun(t, 'user_alice');

		await expect(run.asUser.action(api.payments.mandateSetup, setupArgs(run))).rejects.toThrow(
			/PRAVA_BACKEND_URL is not configured/
		);
	});

	it('resolves the synced account email without a caller identity', async () => {
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

		// Executor actions run under the execution secret with no user JWT;
		// this is exactly how the agent calls the tool action.
		const result = await t.action(api.payments.mandateSetup, setupArgs(run));
		expect(result.approvalUrl).toBe('https://pay.prava.space/approve/1');
		const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
		expect(body.user_email).toBe('user_alice@example.com');
	});

	it('syncs a pending mandate to active once the owner approves', async () => {
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

	it('charges an active mandate and returns credentials without persisting them', async () => {
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

		const stored = await t.run(async (ctx) => ctx.db.get('mandateCharges', charge.chargeId));
		expect(stored).toMatchObject({
			userId: 'user_alice',
			pravaTransactionId: 'txn_9',
			amount: 4_000,
			status: 'awaiting_result'
		});
		expect(stored).not.toHaveProperty('token');
		expect(stored).not.toHaveProperty('dynamicCvv');
		expect(stored).not.toHaveProperty('expiryMonth');
		expect(stored).not.toHaveProperty('expiryYear');
	});

	it('charges after Prava restores remaining even if the local remaining is zero', async () => {
		const t = initConvexTest();
		const run = await startRun(t, 'user_alice');
		const { setup, fetchMock } = await createApprovedMandate(t, run);

		await run.asUser.action(api.payments.mandateStatus, {
			mandateId: setup.mandateId,
			...auth(run)
		});
		await t.run(async (ctx) => {
			await ctx.db.patch('mandates', setup.mandateId, { remaining: 0 });
		});

		fetchMock.mockResolvedValueOnce(jsonResponse(liveListedMandate({ remaining: '120.00' })));
		fetchMock.mockResolvedValueOnce(
			jsonResponse({
				transactionId: 'txn_renewed',
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
			description: 'Order after renewal',
			...auth(run)
		});

		expect(charge.transactionId).toBe('txn_renewed');
		const stored = await t.run(async (ctx) => ctx.db.get('mandates', setup.mandateId));
		expect(stored?.remaining).toBe(12_000);
	});

	it('charges after Prava reports active even if the local mandate is paused', async () => {
		const t = initConvexTest();
		const run = await startRun(t, 'user_alice');
		const { setup, fetchMock } = await createApprovedMandate(t, run);

		await run.asUser.action(api.payments.mandateStatus, {
			mandateId: setup.mandateId,
			...auth(run)
		});
		await t.run(async (ctx) => {
			await ctx.db.patch('mandates', setup.mandateId, { status: 'paused' });
		});

		fetchMock.mockResolvedValueOnce(jsonResponse(liveListedMandate({ status: 'active' })));
		fetchMock.mockResolvedValueOnce(
			jsonResponse({
				transactionId: 'txn_unpaused',
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
			description: 'Order after unpause',
			...auth(run)
		});

		expect(charge.transactionId).toBe('txn_unpaused');
		expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/charge'))).toBe(true);
	});

	it('rejects a charge when the refreshed remaining is below the amount', async () => {
		const t = initConvexTest();
		const run = await startRun(t, 'user_alice');
		const { setup, fetchMock } = await createApprovedMandate(t, run);

		await run.asUser.action(api.payments.mandateStatus, {
			mandateId: setup.mandateId,
			...auth(run)
		});

		fetchMock.mockResolvedValueOnce(jsonResponse(liveListedMandate({ remaining: '10.00' })));

		await expect(
			run.asUser.action(api.payments.mandateCharge, {
				mandateId: setup.mandateId,
				amount: '40.00',
				currency: 'USD',
				description: 'Order 8842',
				reference: 'order-low-remaining',
				...auth(run)
			})
		).rejects.toThrow(/remaining/);
		expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/charge'))).toBe(false);
	});

	it('releases the reservation when mandate refresh fails so the same reference can retry', async () => {
		const t = initConvexTest();
		const run = await startRun(t, 'user_alice');
		const { setup, fetchMock } = await createApprovedMandate(t, run);

		await run.asUser.action(api.payments.mandateStatus, {
			mandateId: setup.mandateId,
			...auth(run)
		});

		fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'temporary outage' } }, 503));

		await expect(
			run.asUser.action(api.payments.mandateCharge, {
				mandateId: setup.mandateId,
				amount: '40.00',
				currency: 'USD',
				description: 'Order 8842',
				reference: 'order-refresh-retry',
				...auth(run)
			})
		).rejects.toThrow();

		fetchMock.mockResolvedValueOnce(jsonResponse(liveListedMandate()));
		fetchMock.mockResolvedValueOnce(
			jsonResponse({
				transactionId: 'txn_retry',
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
			reference: 'order-refresh-retry',
			...auth(run)
		});

		expect(charge.transactionId).toBe('txn_retry');
	});

	it('reuses a completed charge handle without replaying credentials', async () => {
		const t = initConvexTest();
		const run = await startRun(t, 'user_alice');
		const { setup, fetchMock } = await createApprovedMandate(t, run);
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

		const first = await run.asUser.action(api.payments.mandateCharge, {
			mandateId: setup.mandateId,
			amount: '40.00',
			currency: 'USD',
			description: 'Order 8842',
			reference: 'order-8842',
			...auth(run)
		});

		fetchMock.mockClear();

		const second = await run.asUser.action(api.payments.mandateCharge, {
			mandateId: setup.mandateId,
			amount: '40.00',
			currency: 'USD',
			description: 'Order 8842',
			reference: 'order-8842',
			...auth(run)
		});

		expect(second).toEqual({
			chargeId: first.chargeId,
			transactionId: first.transactionId
		});
		expect(second).not.toHaveProperty('token');
		expect(second).not.toHaveProperty('dynamicCvv');
		expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/charge'))).toBe(false);

		const charges = await t.run(async (ctx) =>
			ctx.db
				.query('mandateCharges')
				.withIndex('by_mandate_reference', (query) =>
					query.eq('mandateId', setup.mandateId).eq('reference', 'order-8842')
				)
				.collect()
		);

		expect(charges).toHaveLength(1);
		expect(charges[0]).not.toHaveProperty('dynamicCvv');
	});

	it('refuses to re-POST after a lost Prava charge response for the same reference', async () => {
		const t = initConvexTest();
		const run = await startRun(t, 'user_alice');
		const { setup, fetchMock } = await createApprovedMandate(t, run);

		// Prava may have accepted the charge even though the client saw a transport error.
		fetchMock.mockRejectedValueOnce(new Error('network lost after charge commit'));
		await expect(
			run.asUser.action(api.payments.mandateCharge, {
				mandateId: setup.mandateId,
				amount: '40.00',
				currency: 'USD',
				description: 'Order 8842',
				reference: 'order-8842',
				...auth(run)
			})
		).rejects.toThrow(/network lost after charge commit/);

		const afterLoss = await t.run(async (ctx) =>
			ctx.db
				.query('mandateCharges')
				.withIndex('by_mandate_reference', (query) =>
					query.eq('mandateId', setup.mandateId).eq('reference', 'order-8842')
				)
				.unique()
		);

		expect(afterLoss?.providerRequestedAt).toEqual(expect.any(Number));
		expect(afterLoss?.pravaTransactionId).toBeUndefined();
		expect(afterLoss?.chargingStartedAt).toBeUndefined();

		fetchMock.mockClear();
		// Even after the claim is long stale, do not reclaim for a second POST.
		await t.run(async (ctx) => {
			if (!afterLoss) throw new Error('missing charge');
			await ctx.db.patch('mandateCharges', afterLoss._id, {
				chargingStartedAt: Date.now() - 120_000
			});
		});
		await expect(
			run.asUser.action(api.payments.mandateCharge, {
				mandateId: setup.mandateId,
				amount: '40.00',
				currency: 'USD',
				description: 'Order 8842',
				reference: 'order-8842',
				...auth(run)
			})
		).rejects.toThrow(/may have already been submitted/);
		expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/charge'))).toBe(false);
	});

	it('rejects over-cap, invalid, and currency-mismatched charges without calling Prava', async () => {
		const t = initConvexTest();
		const run = await startRun(t, 'user_alice');
		const { setup, fetchMock } = await createApprovedMandate(t, run);
		fetchMock.mockClear();

		const base = { mandateId: setup.mandateId, description: 'Order 8842', ...auth(run) };
		await expect(
			run.asUser.action(api.payments.mandateCharge, {
				...base,
				amount: '1200.00',
				currency: 'USD'
			})
		).rejects.toThrow(/exceeds the mandate's 120.00 cap/);
		await expect(
			run.asUser.action(api.payments.mandateCharge, {
				...base,
				amount: '40.00',
				currency: 'EUR'
			})
		).rejects.toThrow(/currency must match/);
		await expect(
			run.asUser.action(api.payments.mandateCharge, {
				...base,
				amount: '-5',
				currency: 'USD'
			})
		).rejects.toThrow(/positive decimal/);

		// None of these should have issued a charge request.
		expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/charge'))).toBe(false);
	});

	it('rejects charging a paused mandate before calling Prava', async () => {
		const t = initConvexTest();
		const run = await startRun(t, 'user_alice');

		const { setup, fetchMock } = await createApprovedMandate(t, run, [
			liveListedMandate({ status: 'paused' })
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
		).rejects.toThrow(/paused|not active/);
		expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/charge'))).toBe(false);
	});

	it('does not resolve a mandate approved in a different currency', async () => {
		const t = initConvexTest();
		const run = await startRun(t, 'user_alice');

		// Only a EUR approval exists for the USD local mandate's merchant + cap.
		const { setup } = await createApprovedMandate(t, run, [
			liveListedMandate({ id: 'mdt_eur', currency: 'EUR' })
		]);

		await expect(
			run.asUser.action(api.payments.mandateCharge, {
				mandateId: setup.mandateId,
				amount: '40.00',
				currency: 'USD',
				description: 'Order 8842',
				...auth(run)
			})
		).rejects.toThrow(/not yet approved/);
	});

	it('does not resolve an approval whose scope or cadence differs', async () => {
		const t = initConvexTest();
		const run = await startRun(t, 'user_alice');

		// Same merchant + cap + currency, but approved as any-merchant.
		const { setup } = await createApprovedMandate(t, run, [
			liveListedMandate({ id: 'mdt_any', merchantScope: 'any' })
		]);

		await expect(
			run.asUser.action(api.payments.mandateCharge, {
				mandateId: setup.mandateId,
				amount: '40.00',
				currency: 'USD',
				description: 'Order 8842',
				...auth(run)
			})
		).rejects.toThrow(/not yet approved/);

		// Same again, but approved with a weekly cadence instead of monthly.
		const { setup: weeklySetup } = await createApprovedMandate(t, run, [
			liveListedMandate({ id: 'mdt_weekly', recurringFrequency: 'weekly' })
		]);

		await expect(
			run.asUser.action(api.payments.mandateCharge, {
				mandateId: weeklySetup.mandateId,
				amount: '40.00',
				currency: 'USD',
				description: 'Order 8842',
				...auth(run)
			})
		).rejects.toThrow(/not yet approved/);
	});

	it('reports a charge outcome only once', async () => {
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

		fetchMock.mockResolvedValue(jsonResponse({ status: 'completed', mandateStatus: 'active' }));

		const first = await settleMandateReport(t, run, {
			chargeId: charge.chargeId,
			outcome: 'approved'
		});

		const second = await settleMandateReport(t, run, {
			chargeId: charge.chargeId,
			outcome: 'approved'
		});

		expect(first).toMatchObject({ reported: true });
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
			ctx.db.patch('mandateCharges', charge.chargeId, {
				reportingStartedAt: stale,
				reportOutcome: 'approved'
			})
		);
		fetchMock.mockClear();
		fetchMock.mockResolvedValue(jsonResponse({ status: 'completed', mandateStatus: 'active' }));

		const result = await settleMandateReport(t, run, {
			chargeId: charge.chargeId,
			outcome: 'approved'
		});

		expect(result).toMatchObject({ reported: true });
		// The retry must actually deliver the outcome to Prava, not just finalize locally.
		const reportCall = fetchMock.mock.calls.at(-1)!;
		expect(String(reportCall[0])).toBe(
			'https://sandbox.api.prava.space/v1/mandates/mdt_1/charges/txn_9/report'
		);
		expect(JSON.parse(String(reportCall[1]?.body))).toMatchObject({
			txn_status: 'APPROVED',
			txn_type: 'PURCHASE'
		});
		const stored = await t.run(async (ctx) => ctx.db.get('mandateCharges', charge.chargeId));
		expect(stored).toMatchObject({ status: 'completed', reportedAt: expect.any(Number) });
	});

	it('rejects an opposite-outcome retry instead of posting a conflicting report', async () => {
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

		// Crash boundary: approved was claimed (and may already have been POSTed
		// to Prava), but never finalized locally. A declined retry must not
		// overwrite it and send the opposite terminal outcome.
		const stale = Date.now() - 120_000;
		await t.run(async (ctx) =>
			ctx.db.patch('mandateCharges', charge.chargeId, {
				reportingStartedAt: stale,
				reportOutcome: 'approved'
			})
		);
		fetchMock.mockClear();

		await expect(
			run.asUser.action(api.payments.mandateReport, {
				chargeId: charge.chargeId,
				outcome: 'declined',
				...auth(run)
			})
		).rejects.toThrow(/approved report in progress/);
		expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/report'))).toBe(false);
		const stored = await t.run(async (ctx) => ctx.db.get('mandateCharges', charge.chargeId));
		expect(stored).toMatchObject({ reportOutcome: 'approved' });
		expect(stored?.reportedAt).toBeUndefined();
	});

	it('keeps the first-claimed outcome after a lost Prava response', async () => {
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

		// Prava may have accepted APPROVED even though the client saw a transport error.
		fetchMock.mockRejectedValue(new Error('network lost after commit'));
		vi.useFakeTimers();

		try {
			const first = await run.asUser.action(api.payments.mandateReport, {
				chargeId: charge.chargeId,
				outcome: 'approved',
				...auth(run)
			});

			expect(first).toEqual({ reported: false, inFlight: true });
			await t.finishAllScheduledFunctions(() => {
				vi.advanceTimersByTime(25);
			});

			const afterLoss = await t.run(async (ctx) => ctx.db.get('mandateCharges', charge.chargeId));
			expect(afterLoss).toMatchObject({ reportOutcome: 'approved' });
			expect(afterLoss?.reportedAt).toBeUndefined();

			fetchMock.mockClear();
			await expect(
				run.asUser.action(api.payments.mandateReport, {
					chargeId: charge.chargeId,
					outcome: 'declined',
					...auth(run)
				})
			).rejects.toThrow(/approved report in progress/);
			expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/report'))).toBe(false);

			// Same-outcome retry can still re-send (Prava is idempotent on txn id).
			fetchMock.mockResolvedValue(jsonResponse({ status: 'completed', mandateStatus: 'active' }));

			const retry = await settleMandateReport(t, run, {
				chargeId: charge.chargeId,
				outcome: 'approved'
			});

			expect(retry).toMatchObject({ reported: true });
			expect(JSON.parse(String(fetchMock.mock.calls.at(-1)![1]?.body))).toMatchObject({
				txn_status: 'APPROVED'
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('reports an in-flight claim as not-yet-reported instead of claiming success', async () => {
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
			ctx.db.patch('mandateCharges', charge.chargeId, {
				reportingStartedAt: Date.now(),
				reportOutcome: 'approved'
			})
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
		const stored = await t.run(async (ctx) => ctx.db.get('mandateCharges', charge.chargeId));
		expect(stored?.reportedAt).toBeUndefined();
	});

	it('rejects a recurring frequency for an any-merchant mandate', async () => {
		const t = initConvexTest();
		const run = await startRun(t, 'user_alice');

		await expect(
			run.asUser.action(api.payments.mandateSetup, {
				scope: 'any',
				frequency: 'monthly',
				amountCap: '200.00',
				currency: 'USD',
				description: 'Weekly groceries',
				...auth(run)
			})
		).rejects.toThrow(/one-time/);
	});

	it('rejects charging when multiple approved mandates match instead of picking one', async () => {
		const t = initConvexTest();
		const run = await startRun(t, 'user_alice');

		// Two approvals with the same merchant + amount: resolution must not guess.
		const { setup, fetchMock } = await createApprovedMandate(t, run, [
			liveListedMandate({ id: 'mdt_old' }),
			liveListedMandate({ id: 'mdt_new' })
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
		).rejects.toThrow(/Cannot uniquely match this setup/);
		// No charge POST should have been issued against either mandate.
		expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/charge'))).toBe(false);
	});

	it('syncs a pending mandate to active when exactly one live approval matches', async () => {
		const t = initConvexTest();
		const run = await startRun(t, 'user_alice');

		// A stale cancelled approval with the same merchant + amount must not
		// poison resolution of the one live mandate.
		const { setup } = await createApprovedMandate(t, run, [
			liveListedMandate({ id: 'mdt_stale', status: 'cancelled', remaining: undefined }),
			liveListedMandate({ id: 'mdt_live' })
		]);

		const status = await run.asUser.action(api.payments.mandateStatus, {
			mandateId: setup.mandateId,
			...auth(run)
		});

		expect(status).toMatchObject({ status: 'active', pravaMandateId: 'mdt_live' });
		const stored = await t.run(async (ctx) => await ctx.db.get('mandates', setup.mandateId));
		expect(stored).toMatchObject({ status: 'active', pravaMandateId: 'mdt_live' });
	});

	it('lists only the calling user’s mandates via the user-facing action', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse({
				mandates: [liveListedMandate()]
			})
		);

		vi.stubGlobal('fetch', fetchMock);
		const t = initConvexTest();
		const alice = await startRun(t, 'user_alice');

		const result = await alice.asUser.action(api.payments.listMyMandates, {});

		expect(result.mandates).toHaveLength(1);
		expect(result.mandates[0]).toMatchObject({ pravaMandateId: 'mdt_1', status: 'active' });
		// Scoped to the caller, all mandate kinds (standing and one-time).
		expect(String(fetchMock.mock.calls[0][0])).toBe(
			'https://sandbox.api.prava.space/v1/mandates?customer_id=user_alice'
		);
	});

	it('does not link an approval when multiple local setups match it', async () => {
		const t = initConvexTest();
		const alice = await startRun(t, 'user_alice');

		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({
					session_id: 'prava-session-1',
					iframe_url: 'https://pay.prava.space/approve/1',
					session_token: 'session-token-1',
					expires_at: '2026-08-01T10:15:00Z'
				})
			)
			.mockResolvedValueOnce(
				jsonResponse({
					session_id: 'prava-session-2',
					iframe_url: 'https://pay.prava.space/approve/2',
					session_token: 'session-token-2',
					expires_at: '2026-08-01T10:15:00Z'
				})
			)
			.mockResolvedValueOnce(
				jsonResponse({
					mandates: [liveListedMandate()]
				})
			);

		vi.stubGlobal('fetch', fetchMock);

		const setupArgs = {
			merchantName: 'Example Shop',
			merchantUrl: 'https://shop.example',
			countryCode: 'US',
			amountCap: '120.00',
			currency: 'USD',
			frequency: 'monthly' as const,
			scope: 'listed' as const
		};

		const first = await alice.asUser.action(api.payments.setupMyMandate, {
			...setupArgs,
			description: 'Budget A'
		});

		const second = await alice.asUser.action(api.payments.setupMyMandate, {
			...setupArgs,
			description: 'Budget B'
		});

		const result = await alice.asUser.action(api.payments.listMyMandates, {});

		expect(result.mandates).toHaveLength(1);
		expect(result.mandates[0].mandateId).toBeUndefined();
		const storedFirst = await t.run(async (ctx) => await ctx.db.get('mandates', first.mandateId));
		const storedSecond = await t.run(async (ctx) => await ctx.db.get('mandates', second.mandateId));
		expect(storedFirst?.pravaMandateId).toBeUndefined();
		expect(storedSecond?.pravaMandateId).toBeUndefined();
	});

	it('links a newly approved mandate so settings can pause or cancel it', async () => {
		const t = initConvexTest();
		const alice = await startRun(t, 'user_alice');

		// Setup inserts a local pending row without pravaMandateId. New-tab
		// approval never calls mandateStatus, so listing itself must link it.
		// Prava normalizes "120" → "120.00"; matching must tolerate that.
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({
					session_id: 'prava-session-1',
					iframe_url: 'https://pay.prava.space/approve/1',
					session_token: 'session-token-1',
					expires_at: '2026-08-01T10:15:00Z'
				})
			)
			.mockResolvedValueOnce(
				jsonResponse({
					mandates: [liveListedMandate()]
				})
			);

		vi.stubGlobal('fetch', fetchMock);

		const setup = await alice.asUser.action(api.payments.setupMyMandate, {
			merchantName: 'Example Shop',
			merchantUrl: 'https://shop.example',
			countryCode: 'US',
			amountCap: '120',
			currency: 'USD',
			frequency: 'monthly' as const,
			scope: 'listed' as const,
			description: 'Monthly budget'
		});

		const result = await alice.asUser.action(api.payments.listMyMandates, {});

		expect(result.mandates).toHaveLength(1);
		expect(result.mandates[0]).toMatchObject({
			mandateId: setup.mandateId,
			pravaMandateId: 'mdt_1',
			status: 'active',
			description: 'Monthly budget'
		});
		const stored = await t.run(async (ctx) => await ctx.db.get('mandates', setup.mandateId));
		expect(stored).toMatchObject({
			pravaMandateId: 'mdt_1',
			status: 'active',
			amountCap: 12_000,
			description: 'Monthly budget'
		});
	});

	it('treats a first-time customer’s CUSTOMER_NOT_FOUND as an empty mandate list', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				jsonResponse(
					{ error: { code: 'CUSTOMER_NOT_FOUND', message: 'No such customer for this merchant' } },
					404
				)
			);

		vi.stubGlobal('fetch', fetchMock);
		const t = initConvexTest();
		const alice = await startRun(t, 'user_alice');

		const result = await alice.asUser.action(api.payments.listMyMandates, {});

		expect(result.mandates).toEqual([]);
	});

	it('rejects the user-facing lifecycle action on another user’s mandate', async () => {
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
					mandates: [liveListedMandate()]
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
