import { describe, expect, it } from 'vitest';
import { ConvexError } from 'convex/values';
import { toAgentToolConvexError } from '@convex/lib/agentErrors';

describe('agent tool error surfacing', () => {
	it('removes nested Convex transport prefixes before rethrowing a tool error', () => {
		const message =
			'The user has control of this browser. Ask them to give control back before browsing.';
		for (const error of [
			new Error(`Uncaught ConvexError: ${message}\n    at acquire`),
			new ConvexError(`Uncaught ConvexError: Uncaught ConvexError: ${message}\n    at acquire`)
		]) {
			expect(toAgentToolConvexError(error)).toMatchObject({ data: message, message });
		}
	});
});
