import { describe, expect, it } from 'vitest';
import { ConvexError } from 'convex/values';
import { UNSUPPORTED_CLIENT_MESSAGE, unsupportedClient } from '@convex/lib/unsupportedClient';

describe('unsupportedClient', () => {
	it('throws a ConvexError with the update message', () => {
		expect(() => unsupportedClient()).toThrow(ConvexError);
		expect(() => unsupportedClient()).toThrow(UNSUPPORTED_CLIENT_MESSAGE);
	});
});
