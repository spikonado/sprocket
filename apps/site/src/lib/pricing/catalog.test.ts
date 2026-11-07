import { describe, expect, test } from 'bun:test';
import { buildPlanCards, formatPrice } from './catalog';

describe('formatPrice', () => {
	test('uses each currency’s minor units', () => {
		expect(formatPrice({ amountMinor: 2000, currency: 'USD' })).toBe('$20');
		expect(formatPrice({ amountMinor: 1999, currency: 'USD' })).toBe('$19.99');
		expect(formatPrice({ amountMinor: 3000, currency: 'JPY' })).toBe('¥3,000');
		expect(formatPrice({ amountMinor: 12_345, currency: 'KWD' })).toMatch(/^KWD\s12\.345$/);
	});
});

test('buildPlanCards prices plans and lists only what each tier adds', () => {
	const [free, pro, ultra] = buildPlanCards({
		plans: [
			{
				id: 'free',
				label: 'Free',
				monthlyUsageDollars: 5,
				description: null,
				features: [],
				highlighted: false,
				prices: { monthly: null, annual: null }
			},
			{
				id: 'pro',
				label: 'Pro',
				monthlyUsageDollars: 50,
				description: ' For daily work ',
				features: ['Frontier models', ' '],
				highlighted: true,
				prices: {
					monthly: { amountMinor: 2000, currency: 'USD' },
					annual: { amountMinor: 20_000, currency: 'USD' }
				}
			},
			{
				id: 'ultra',
				label: 'Ultra',
				monthlyUsageDollars: 300,
				description: null,
				features: ['Frontier models', 'Priority support'],
				highlighted: false,
				prices: { monthly: null, annual: null }
			}
		]
	});
	expect(free.prices).toEqual({ monthly: '$0', annual: '$0' });
	expect(free.previousPlanName).toBeNull();
	expect(free.features.map(({ label }) => label)).toEqual([
		'$5 of AI usage each month',
		'Bring your own API keys and subscriptions',
		'Limited context from the web',
		'Fair source',
		'Self-host anytime'
	]);
	expect(pro).toMatchObject({
		description: 'For daily work',
		previousPlanName: 'Free',
		prices: { monthly: '$20', annual: '$200' },
		annualPerMonth: '$16.67',
		annualDiscountPercent: 17
	});
	expect(pro.features.map(({ label }) => label)).toEqual([
		'$50 of AI usage each month',
		'Unlimited context from the web',
		'Frontier models'
	]);
	expect(ultra.previousPlanName).toBe('Pro');
	expect(ultra.features.map(({ label }) => label)).toEqual([
		'$300 of AI usage each month',
		'Priority support'
	]);
});
