import { expect, test } from 'bun:test';
import { ConvexError } from 'convex/values';
import { assertCheckoutUrl, userFacingError } from './billing';

test('checkout links must be on the Dodo host for the backend’s mode', () => {
	expect(() =>
		assertCheckoutUrl('https://checkout.dodopayments.com/session/cks_1', 'live')
	).not.toThrow();
	expect(() =>
		assertCheckoutUrl('https://test.checkout.dodopayments.com/session/cks_1', 'live')
	).toThrow('Checkout returned an invalid link.');
});

test('billing refusals show their backend message', () => {
	expect(userFacingError(new ConvexError('Use "Manage billing".'))).toBe('Use "Manage billing".');
	expect(userFacingError(new Error('[Request ID: 1] Server Error'))).toBeNull();
});
