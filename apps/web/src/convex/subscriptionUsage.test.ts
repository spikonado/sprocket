import { WEEK } from '@convex-dev/rate-limiter';
import { describe, expect, it } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import {
	rateLimiter,
	URL_SCRAPE_USAGE_UNITS,
	WEB_SEARCH_USAGE_UNITS
} from '@convex/lib/rateLimits';
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
		const weekly = model?.windows.find((window) => window.period === 'weekly');
		expect(weekly && weekly.used > weekly.limit).toBe(true);
		await expect(
			t.mutation(internal.lib.rateLimits.checkModelUsageLimits, { userId })
		).rejects.toThrow('Monthly model usage limit reached');
	});

	it('charges scrape and search against one shared web tools quota', async () => {
		const t = initConvexTest();
		const userId = 'user_web_tools';
		const asUser = t.withIdentity({ subject: userId });
		const used = async () => {
			const usage = await asUser.query(api.usage.getMyUsage, {});
			const meter = usage.meters.find((meter) => meter.id === 'webTools');
			return meter?.windows.find((window) => window.period === 'monthly')?.used ?? 0;
		};

		await t.mutation(internal.lib.rateLimits.chargeUrlScrapeLimits, { userId });
		expect(await used()).toBe(URL_SCRAPE_USAGE_UNITS);

		await t.mutation(internal.lib.rateLimits.chargeWebSearchLimits, { userId });
		expect(await used()).toBe(URL_SCRAPE_USAGE_UNITS + WEB_SEARCH_USAGE_UNITS);

		// Same flat search cost again (not scaled by result count).
		await t.mutation(internal.lib.rateLimits.chargeWebSearchLimits, {
			userId,
			numResults: 10
		});
		expect(await used()).toBe(URL_SCRAPE_USAGE_UNITS + 2 * WEB_SEARCH_USAGE_UNITS);
	});

	it('counts legacy web search and scrape usage toward the shared quota', async () => {
		const t = initConvexTest();
		const userId = 'user_legacy_web_tools';
		const asUser = t.withIdentity({ subject: userId });
		const weekly = { kind: 'fixed window' as const, period: WEEK, rate: 250 };

		await t.run(async (ctx) => {
			await rateLimiter.limit(ctx, 'webSearchWeekly', {
				key: userId,
				config: weekly,
				count: 250,
				reserve: true
			});
			await rateLimiter.limit(ctx, 'urlScrapeWeekly', {
				key: userId,
				config: weekly,
				count: 250,
				reserve: true
			});
		});

		const usage = await asUser.query(api.usage.getMyUsage, {});
		const meter = usage.meters.find((meter) => meter.id === 'webTools');
		const window = meter?.windows.find((window) => window.period === 'weekly');
		expect(window?.used).toBe(500);
		expect(window?.limit).toBe(500);
		await expect(
			t.mutation(internal.lib.rateLimits.checkWebToolsLimits, { userId })
		).rejects.toThrow('Weekly web tools limit reached');
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
