import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import { initConvexTest } from './test.setup';

const day = 86_400_000;

const now = Date.UTC(2026, 9, 2);

const createBody = {
	productId: 'prod_pro',
	returnUrl: 'https://spikonado.com/pricing',
	cancelUrl: 'https://spikonado.com/pricing',
	dodoCustomerId: 'cus_owner'
};

function attempt(attemptId: string) {
	return {
		userId: 'owner',
		attemptId,
		tierId: 'pro',
		interval: 'monthly' as const,
		productId: 'prod_pro',
		expiresAt: now - 40 * day
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(now);
	vi.stubEnv('DODO_PAYMENTS_ENVIRONMENT', 'test_mode');
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe('checkout history safety', () => {
	it('counts locally expired provider links toward the history limit while resuming the current link', async () => {
		const t = initConvexTest();

		await t.run(async (ctx) => {
			for (let index = 0; index < 25; index++) {
				await ctx.db.insert('billingCheckoutAttempts', {
					...attempt(`old_${index}`),
					outcome: 'created',
					dodoSessionId: `cks_${index}`
				});
			}

			await ctx.db.insert('billingCheckoutSessions', {
				...attempt('current'),
				outcome: 'created',
				expiresAt: now + day,
				checkoutUrl: 'https://checkout.example/current'
			});
		});

		await expect(
			t.mutation(internal.billing.reserveCheckoutSession, {
				userId: 'owner',
				tierId: 'pro',
				interval: 'annual',
				productId: 'prod_annual',
				now
			})
		).rejects.toThrow('Contact billing support');

		await expect(
			t.mutation(internal.billing.reserveCheckoutSession, {
				userId: 'owner',
				tierId: 'pro',
				interval: 'monthly',
				productId: 'prod_pro',
				now
			})
		).resolves.toMatchObject({ kind: 'existing', attemptId: 'current' });
	});

	it('prunes only terminal or provably never-sent history and compacts recent terminal rows', async () => {
		const t = initConvexTest();

		await t.run(async (ctx) => {
			const rows: Partial<Doc<'billingCheckoutAttempts'>>[] = [
				{ attemptId: 'paid_old', outcome: 'paid', outcomeUpdatedAt: now - 31 * day },
				{ attemptId: 'failed_old', outcome: 'failed', outcomeUpdatedAt: now - 31 * day },
				{ attemptId: 'never_sent', outcome: 'reserved' },
				{ attemptId: 'ambiguous', outcome: 'create_ambiguous', createRequest: createBody },
				{ attemptId: 'payable', outcome: 'created', dodoSessionId: 'cks_payable' },
				{ attemptId: 'legacy_unknown' },
				{
					attemptId: 'paid_recent',
					outcome: 'paid',
					outcomeUpdatedAt: now,
					checkoutUrl: 'https://checkout.example/recent',
					createRequest: createBody,
					idempotencyKey: 'persisted-key'
				}
			];

			for (const row of rows) {
				if (!row.attemptId) throw new Error('fixture row requires an attemptId');

				await ctx.db.insert('billingCheckoutAttempts', {
					...attempt(row.attemptId),
					...row
				});
			}
		});

		await t.mutation(internal.billing.cleanupCheckoutHistory, {
			table: 'billingCheckoutAttempts'
		});

		const retained = await t.run((ctx) => ctx.db.query('billingCheckoutAttempts').collect());

		expect(retained.map((row) => row.attemptId).sort()).toEqual([
			'ambiguous',
			'legacy_unknown',
			'paid_recent',
			'payable'
		]);

		const compact = retained.find((row) => row.attemptId === 'paid_recent');

		expect(compact?.outcome).toBe('paid');
		expect(compact?.checkoutUrl).toBeUndefined();
		expect(compact?.createRequest).toBeUndefined();
		expect(compact?.idempotencyKey).toBeUndefined();
	});

	it('retries only inside the confirmed provider window measured from the first create', async () => {
		const t = initConvexTest();

		await t.run((ctx) =>
			ctx.db.insert('billingCheckoutSessions', {
				...attempt('retry'),
				outcome: 'create_ambiguous',
				createRequest: createBody,
				idempotencyKey: 'original-key',
				createStartedAt: now - 60_000
			})
		);

		const freeze = () =>
			t.mutation(internal.billing.freezeCheckoutCreateRequest, {
				userId: 'owner',
				attemptId: 'retry',
				createBody: { ...createBody, returnUrl: 'https://changed.example' }
			});

		await expect(freeze()).rejects.toThrow('provider confirmation');
		vi.stubEnv('DODO_CHECKOUT_IDEMPOTENCY_WINDOW_MS', '120000');
		await expect(freeze()).resolves.toEqual({
			idempotencyKey: 'original-key',
			createRequest: createBody
		});
		vi.setSystemTime(now + 60_000);
		await expect(freeze()).rejects.toThrow('provider confirmation');

		const row = await t.run((ctx) => ctx.db.query('billingCheckoutSessions').unique());

		expect(row?.createStartedAt).toBe(now - 60_000);
	});

	it('keeps legacy unknown attempts unresolved and refuses to invent their provider key', async () => {
		const t = initConvexTest();

		await t.run((ctx) => ctx.db.insert('billingCheckoutSessions', attempt('legacy')));
		await expect(
			t.mutation(internal.billing.freezeCheckoutCreateRequest, {
				userId: 'owner',
				attemptId: 'legacy',
				createBody
			})
		).rejects.toThrow('legacy checkout needs provider confirmation');

		const owner = t.withIdentity({ subject: 'owner' });

		await expect(
			owner.action(api.billing.getCheckoutStatus, { attemptId: 'legacy' })
		).resolves.toMatchObject({ status: 'unknown' });
	});

	it('walks every page of a table larger than one cleanup page', async () => {
		const t = initConvexTest();

		await t.run(async (ctx) => {
			for (let index = 0; index < 101; index++) {
				await ctx.db.insert('billingCheckoutAttempts', {
					...attempt(`paid_old_${index}`),
					outcome: 'paid',
					outcomeUpdatedAt: now - 31 * day
				});
			}

			await ctx.db.insert('billingCheckoutAttempts', {
				...attempt('payable'),
				outcome: 'created',
				dodoSessionId: 'cks_payable'
			});
		});

		await t.mutation(internal.billing.cleanupCheckoutHistory, {
			table: 'billingCheckoutAttempts'
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const retained = await t.run((ctx) => ctx.db.query('billingCheckoutAttempts').collect());

		expect(retained.map((row) => row.attemptId)).toEqual(['payable']);
	});

	it('preserves the provider session identity when refreshing a retained checkout link', async () => {
		const t = initConvexTest();

		await t.run((ctx) =>
			ctx.db.insert('billingCheckoutAttempts', {
				...attempt('retained'),
				outcome: 'created',
				dodoSessionId: 'cks_original'
			})
		);
		await t.mutation(internal.billing.attachCheckoutSession, {
			userId: 'owner',
			attemptId: 'retained',
			checkoutUrl: 'https://checkout.example/refreshed'
		});

		const row = await t.run((ctx) => ctx.db.query('billingCheckoutAttempts').unique());

		expect(row).toMatchObject({
			outcome: 'created',
			dodoSessionId: 'cks_original',
			checkoutUrl: 'https://checkout.example/refreshed'
		});
	});

	it.each([
		['billingCheckoutSessions', 'paid'],
		['billingCheckoutSessions', 'failed'],
		['billingCheckoutAttempts', 'paid'],
		['billingCheckoutAttempts', 'failed']
	] as const)(
		'preserves a compact %s %s outcome across delayed create completion',
		async (table, outcome) => {
			const t = initConvexTest();

			await t.run((ctx) =>
				ctx.db.insert(table, {
					...attempt('terminal'),
					outcome,
					outcomeUpdatedAt: now - 1_000
				})
			);
			await t.mutation(internal.billing.attachCheckoutSession, {
				userId: 'owner',
				attemptId: 'terminal',
				checkoutUrl: 'https://checkout.example/late',
				sessionId: 'cks_late',
				createBody,
				idempotencyKey: 'old-key'
			});
			await t.mutation(internal.billing.markCheckoutAttemptAmbiguous, {
				userId: 'owner',
				attemptId: 'terminal'
			});

			const row = await t.run((ctx) => ctx.db.query(table).unique());

			expect(row).toMatchObject({ outcome, outcomeUpdatedAt: now - 1_000 });
			expect(row?.checkoutUrl).toBeUndefined();
			expect(row?.createRequest).toBeUndefined();
			expect(row?.idempotencyKey).toBeUndefined();
		}
	);
});
