import { describe, expect, it } from 'vitest';
import { resolveMarketingPricingUrls } from './marketingOrigin';

describe('billing return origins', () => {
	it('uses an explicitly configured production origin and opaque recovery reference', () => {
		expect(
			resolveMarketingPricingUrls(
				{
					SPROCKET_MARKETING_ORIGIN: 'https://spikonado.com/',
					DODO_PAYMENTS_ENVIRONMENT: 'live_mode'
				},
				'team & pro',
				'opaque/attempt'
			)
		).toEqual({
			return_url:
				'https://spikonado.com/pricing?checkout=return&tier=team%20%26%20pro&attempt=opaque%2Fattempt',
			cancel_url: 'https://spikonado.com/pricing?checkout=cancel&tier=team%20%26%20pro'
		});
	});
	it('accepts only the explicitly approved HTTPS staging origin in test mode', () => {
		const env = {
			DODO_PAYMENTS_ENVIRONMENT: 'test_mode',
			SPROCKET_BILLING_STAGING_ORIGIN: 'https://billing-stage.example.com',
			SPROCKET_MARKETING_ORIGIN: 'https://billing-stage.example.com'
		};

		expect(resolveMarketingPricingUrls(env, 'pro').return_url).toContain(
			'https://billing-stage.example.com/pricing'
		);
		expect(() =>
			resolveMarketingPricingUrls({ ...env, DODO_PAYMENTS_ENVIRONMENT: 'live_mode' }, 'pro')
		).toThrow('approved billing origin');
		expect(() =>
			resolveMarketingPricingUrls(
				{ ...env, SPROCKET_MARKETING_ORIGIN: 'https://other.example.com' },
				'pro'
			)
		).toThrow('approved billing origin');
	});
	it('retains local test development without silently redirecting invalid configuration', () => {
		expect(
			resolveMarketingPricingUrls(
				{
					DODO_PAYMENTS_ENVIRONMENT: 'test_mode',
					SPROCKET_MARKETING_ORIGIN: 'http://localhost:4321'
				},
				'pro'
			).return_url
		).toContain('http://localhost:4321/pricing');
		expect(() => resolveMarketingPricingUrls({}, 'pro')).toThrow('must be configured');
		expect(() =>
			resolveMarketingPricingUrls({ SPROCKET_MARKETING_ORIGIN: 'http://localhost:4321' }, 'pro')
		).toThrow('approved billing origin');
	});
	it.each([
		'http://stage.example.com',
		'https://user:password@stage.example.com',
		'https://stage.example.com/path',
		'https://stage.example.com?redirect=1',
		'https://stage.example.com#fragment'
	])('rejects malformed staging allowlist entry %s', (staging) => {
		expect(() =>
			resolveMarketingPricingUrls(
				{
					DODO_PAYMENTS_ENVIRONMENT: 'test_mode',
					SPROCKET_MARKETING_ORIGIN: 'https://spikonado.com',
					SPROCKET_BILLING_STAGING_ORIGIN: staging
				},
				'pro'
			)
		).toThrow();
	});
});
