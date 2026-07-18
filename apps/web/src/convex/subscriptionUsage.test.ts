import { describe, expect, it } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import { initConvexTest } from './test.setup';

describe('subscription and usage backend', () => {
	it('reports weighted model usage and preserves overdraft', async () => {
		const t = initConvexTest();
		const userId = 'user_usage';
		const asUser = t.withIdentity({ subject: userId });
		await t.mutation(internal.lib.rateLimits.chargeModelUsageLimits, {
			userId,
			modelId: 'gpt-5.6-sol',
			serviceTier: 'standard',
			tokens: { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 2_000_000 }
		});

		const usage = await asUser.query(api.usage.getMyUsage, {});
		const model = usage.meters.find((meter) => meter.id === 'modelUsage');
		expect(model?.windows.find((window) => window.period === 'weekly')?.used).toBe(100_000);
		await expect(
			t.mutation(internal.lib.rateLimits.checkModelUsageLimits, { userId })
		).rejects.toThrow('Monthly model usage limit reached');
	});

	it('charges web tools in proportion to their request cost', async () => {
		const t = initConvexTest();
		const userId = 'user_web_tools';
		const asUser = t.withIdentity({ subject: userId });

		await t.mutation(internal.lib.rateLimits.chargeUrlScrapeLimits, { userId });
		await t.mutation(internal.lib.rateLimits.chargeWebSearchLimits, {
			userId,
			numResults: 5
		});

		const usage = await asUser.query(api.usage.getMyUsage, {});
		const scrape = usage.meters.find((meter) => meter.id === 'urlScrape');
		const search = usage.meters.find((meter) => meter.id === 'webSearch');
		expect(scrape?.windows.find((window) => window.period === 'monthly')?.used).toBe(1.5);
		expect(search?.windows.find((window) => window.period === 'monthly')?.used).toBe(12);
	});

	it('uses only active subscriptions and ignores stale webhook events', async () => {
		const t = initConvexTest();
		const userId = 'user_billing';
		const asUser = t.withIdentity({ subject: userId });
		const currentTier = async () => (await asUser.query(api.usage.getMyUsage, {})).tier;
		const subscription = {
			userId,
			tier: 'pro',
			dodoSubscriptionId: 'sub_1',
			dodoProductId: 'prod_1',
			dodoCustomerId: 'customer_1'
		} as const;
		expect(await currentTier()).toBe('free');

		await t.mutation(internal.billing.upsertSubscription, {
			...subscription,
			status: 'active',
			eventAt: 1_000
		});
		expect(await currentTier()).toBe('pro');

		await t.mutation(internal.billing.upsertSubscription, {
			...subscription,
			status: 'cancelled',
			eventAt: 2_000
		});
		expect(await currentTier()).toBe('free');

		// A late-arriving older 'active' event must not resurrect the subscription.
		await t.mutation(internal.billing.upsertSubscription, {
			...subscription,
			status: 'active',
			eventAt: 1_500
		});
		expect(await currentTier()).toBe('free');
	});
});
