import { describe, expect, it } from 'vitest';
import { normalizeGuestUserId } from '@convex/lib/guestIdentity';

describe('normalizeGuestUserId', () => {
	it('accepts UUID guest identities', () => {
		expect(normalizeGuestUserId('018f86ee-7f2b-4b6d-91fc-58db3ff64f09')).toBe(
			'guest:018f86ee-7f2b-4b6d-91fc-58db3ff64f09'
		);
	});

	it('normalizes surrounding whitespace and casing', () => {
		expect(normalizeGuestUserId(' 018F86EE-7F2B-4B6D-91FC-58DB3FF64F09 ')).toBe(
			'guest:018f86ee-7f2b-4b6d-91fc-58db3ff64f09'
		);
	});

	it('rejects empty, non-UUID, and prefixed guest identities', () => {
		expect(() => normalizeGuestUserId()).toThrow('Authentication required.');
		expect(() => normalizeGuestUserId('')).toThrow('Authentication required.');
		expect(() => normalizeGuestUserId('guest:018f86ee-7f2b-4b6d-91fc-58db3ff64f09')).toThrow(
			'Authentication required.'
		);
		expect(() => normalizeGuestUserId('user_123')).toThrow('Authentication required.');
	});
});
