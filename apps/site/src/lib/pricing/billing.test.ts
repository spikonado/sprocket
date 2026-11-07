import { expect, test } from 'bun:test';
import { assertCheckoutUrl } from './billing';

test('checkout links must be on the Dodo host for the backend’s mode', () => {
	expect(() =>
		assertCheckoutUrl('https://checkout.dodopayments.com/session/cks_1', 'live')
	).not.toThrow();
	expect(() =>
		assertCheckoutUrl('https://test.checkout.dodopayments.com/session/cks_1', 'live')
	).toThrow('Checkout returned an invalid link.');
});
