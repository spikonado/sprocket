import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@convex/_generated/api';
import { chargeUsage, gatewayQuotaStatus } from '@convex/lib/quota';
import { MODEL_USAGE_UNITS_PER_DOLLAR } from '@convex/lib/tiers';
import {
	initConvexTest,
	insertUser,
	seedTiers,
	sendDodoWebhook,
	stubDodoEnv,
	type ConvexTestInstance
} from './test.setup';

const DAY = 86_400_000;
const DOLLAR = MODEL_USAGE_UNITS_PER_DOLLAR;

type DodoPayment = {
	payment_id: string;
	status: string;
	created_at: string;
	customer: { customer_id: string };
	metadata: Record<string, string>;
	product_cart: { product_id: string; quantity: number }[] | null;
	refunds: { status: string }[];
	disputes: object[];
};

function dodoPayment(overrides: Partial<DodoPayment> = {}): DodoPayment {
	return {
		payment_id: 'pay_pack',
		status: 'succeeded',
		created_at: new Date().toISOString(),
		customer: { customer_id: 'cus_owner' },
		metadata: { userId: 'owner', creditUnits: String(10 * DOLLAR), creditDays: '30' },
		product_cart: [{ product_id: 'prod_pack', quantity: 1 }],
		refunds: [],
		disputes: [],
		...overrides
	};
}

/** Serves Dodo's payment retrieve endpoint from `payments`. */
function stubPayments(payments: DodoPayment[]) {
	stubDodoEnv();
	vi.stubGlobal('fetch', async (input: Request | string | URL) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const found = payments.find((payment) => url.pathname === `/payments/${payment.payment_id}`);

		return found ? Response.json(found) : Response.json({ message: 'Not found' }, { status: 404 });
	});
}

/** No `creditPacks` row: grants use the terms recorded at checkout, so a retired pack still pays out. */
async function setup() {
	const t = initConvexTest();
	await seedTiers(t);
	await t.run((ctx) => insertUser(ctx, 'owner', 'cus_owner'));

	return t;
}

function readGrants(t: ConvexTestInstance) {
	return t.run((ctx) => ctx.db.query('creditGrants').collect());
}

function insertGrant(
	t: ConvexTestInstance,
	paymentId: string,
	{ units = 10 * DOLLAR, expiresAt = Date.now() + 30 * DAY, revoked = false } = {}
) {
	return t.run((ctx) =>
		ctx.db.insert('creditGrants', {
			userId: 'owner',
			paymentId,
			productId: 'prod_pack',
			units,
			used: 0,
			expiresAt,
			revokedAt: revoked ? Date.now() : undefined
		})
	);
}

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe('credit pack grants', () => {
	it('grants a paid pack once per payment on its checkout terms and ignores other payments', async () => {
		const t = await setup();
		const payment = dodoPayment();
		stubPayments([]);

		for (const [type, data] of [
			['payment.succeeded', payment],
			['payment.succeeded', payment],
			['payment.succeeded', dodoPayment({ payment_id: 'pay_renewal', product_cart: null })],
			[
				'payment.succeeded',
				dodoPayment({
					payment_id: 'pay_subscription',
					metadata: { userId: 'owner' },
					product_cart: [{ product_id: 'prod_pro', quantity: 1 }]
				})
			],
			['payment.failed', dodoPayment({ payment_id: 'pay_failed', status: 'failed' })]
		] as const) {
			expect((await sendDodoWebhook(t, type, data)).status).toBe(204);
		}

		const grants = await readGrants(t);
		expect(grants).toMatchObject([
			{
				userId: 'owner',
				paymentId: 'pay_pack',
				productId: 'prod_pack',
				units: 10 * DOLLAR,
				used: 0,
				expiresAt: Date.parse(payment.created_at) + 30 * DAY
			}
		]);
		expect(grants[0]?.revokedAt).toBeUndefined();
	});

	it('revokes a pack on any refund or dispute, whatever the event order, and keeps it revoked', async () => {
		const t = await setup();
		const refunded = dodoPayment({ payment_id: 'pay_refunded' });
		const disputed = dodoPayment({ payment_id: 'pay_disputed' });
		stubPayments([{ ...refunded, refunds: [{ status: 'succeeded' }] }, disputed]);

		await sendDodoWebhook(t, 'refund.succeeded', { payment_id: 'pay_refunded' });
		await sendDodoWebhook(t, 'payment.succeeded', refunded);
		await sendDodoWebhook(t, 'payment.succeeded', disputed);
		await sendDodoWebhook(t, 'dispute.opened', { payment_id: 'pay_disputed' });
		await sendDodoWebhook(t, 'dispute.won', { payment_id: 'pay_disputed' });

		const grants = await readGrants(t);
		expect(grants.map(({ paymentId, revokedAt }) => ({ paymentId, revoked: !!revokedAt }))).toEqual(
			[
				{ paymentId: 'pay_refunded', revoked: true },
				{ paymentId: 'pay_disputed', revoked: true }
			]
		);
		expect(
			await t.withIdentity({ subject: 'owner' }).query(api.usage.getMyUsage, { now: Date.now() })
		).not.toHaveProperty('credits');
	});
});

describe('credit pack draw', () => {
	it('draws the allowance, then grants soonest expiry first, and is exhausted only when both are gone', async () => {
		const t = await setup();
		const now = Date.now();
		const late = await insertGrant(t, 'pay_late', { units: 5 * DOLLAR, expiresAt: now + 60 * DAY });
		const soon = await insertGrant(t, 'pay_soon', { units: 2 * DOLLAR, expiresAt: now + 10 * DAY });
		await insertGrant(t, 'pay_expired', { expiresAt: now - 1 });
		await insertGrant(t, 'pay_revoked', { revoked: true });
		const asOwner = t.withIdentity({ subject: 'owner' });
		const usage = () => asOwner.query(api.usage.getMyUsage, { now: Date.now() });

		const used = (id: typeof late) =>
			t.run(async (ctx) => (await ctx.db.get('creditGrants', id))?.used);

		await t.run((ctx) => chargeUsage(ctx, 'owner', 16 * DOLLAR));

		expect(await usage()).toMatchObject({
			exhausted: false,
			meters: [{ used: 15 * DOLLAR, limit: 15 * DOLLAR }],
			credits: { remaining: 6 * DOLLAR, nextExpiresAt: now + 10 * DAY }
		});
		expect([await used(soon), await used(late)]).toEqual([DOLLAR, 0]);

		await t.run((ctx) => chargeUsage(ctx, 'owner', 3 * DOLLAR));
		expect([await used(soon), await used(late)]).toEqual([2 * DOLLAR, 2 * DOLLAR]);
		expect(await t.run((ctx) => gatewayQuotaStatus(ctx, 'owner'))).toMatchObject({
			exhausted: false
		});

		await t.run((ctx) => chargeUsage(ctx, 'owner', 4 * DOLLAR));

		expect(await used(late)).toBe(5 * DOLLAR);
		expect(await usage()).toMatchObject({
			exhausted: true,
			meters: [{ used: 16 * DOLLAR }]
		});
		expect(await t.run((ctx) => gatewayQuotaStatus(ctx, 'owner'))).toMatchObject({
			exhausted: true
		});
	});
});
