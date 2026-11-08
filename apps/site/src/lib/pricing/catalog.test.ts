import { describe, expect, test } from 'bun:test';
import { buildCreditPackCards, buildPlanCards, formatPrice } from './catalog';

function usdPrice(amountMinor: number) {
	return {
		name: null,
		productId: `pdt_${amountMinor}`,
		amountMinor,
		currency: 'USD',
		paymentFrequencyCount: 1,
		paymentFrequencyInterval: 'Month'
	};
}

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
				displayOrder: 0,
				highlighted: false,
				prices: { monthly: null, annual: null }
			},
			{
				id: 'pro',
				label: 'Pro',
				monthlyUsageDollars: 50,
				description: ' For daily work ',
				features: ['Frontier models', ' '],
				displayOrder: 1,
				highlighted: true,
				prices: { monthly: usdPrice(2000), annual: usdPrice(20_000) }
			},
			{
				id: 'ultra',
				label: 'Ultra',
				monthlyUsageDollars: 300,
				description: null,
				features: ['Frontier models', 'Priority support'],
				displayOrder: 2,
				highlighted: false,
				prices: { monthly: null, annual: null }
			}
		],
		creditPacks: []
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

test('buildCreditPackCards lists only packs with a synced price', () => {
	const price = (productId: string) => ({ productId, amountMinor: 999, currency: 'USD' });

	expect(
		buildCreditPackCards({
			plans: [],
			creditPacks: [
				{
					productId: 'pdt_new',
					usageDollars: 10,
					expiresAfter: { count: 30, unit: 'day' },
					price: null
				},
				{
					productId: 'pdt_10',
					usageDollars: 10,
					expiresAfter: { count: 30, unit: 'day' },
					price: price('pdt_10')
				},
				{
					productId: 'pdt_year',
					usageDollars: 50,
					expiresAfter: { count: 1, unit: 'year' },
					price: price('pdt_year')
				}
			]
		})
	).toEqual([
		{ productId: 'pdt_10', price: '$9.99', usage: '$10', expiresAfter: '30 days' },
		{ productId: 'pdt_year', price: '$9.99', usage: '$50', expiresAfter: '1 year' }
	]);
});
